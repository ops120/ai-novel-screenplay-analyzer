// v17 之前：analysisFlow 只做「结果汇总」。前端切片请求是 for 串行 ——
// 长文本炼化耗时与切片数线性，慢。
// v17：把「并发执行 + 自适应降级」放到这里，保持 store.analyzeText 简洁。
// v18：暴露 failedIndexes / rateLimitCount / degradedFrom 供 UI 实时展示与重试。

export function summarizeChunkResults(results) {
  const failures = [];
  const failedIndexes = [];
  let successCount = 0;

  results.forEach((result, index) => {
    if (result.ok === true) {
      successCount += 1;
      return;
    }
    failedIndexes.push(index);
    failures.push(`切片 ${index + 1}: ${result.message || '未知错误'}`);
  });

  return {
    successCount,
    errorCount: failures.length,
    failedIndexes,
    ok: failures.length === 0,
    message: failures.join('\n'),
  };
}

// ==================== v17：并发执行 + API 限流降级 ====================

// LLM 上游 429/503 是「限流/过载」的明确信号。连续 3 次命中时降级到 1 路并发，
// 避免把 API 越打越死。其它错误（4xx 非 429、网络断开）不计入限流统计。
const RATE_LIMIT_STATUS = new Set([429, 503]);
const RATE_LIMIT_WINDOW = 3;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

/**
 * 并发执行切片分析，自适应降级。
 *
 * @param {object} options
 * @param {Array}  options.chunks         待分析切片，索引与最终 results 数组下标对齐
 * @param {number} options.concurrency    初始并发度（1—8）
 * @param {(chunk:any, index:number, signal:AbortSignal) => Promise<{ok:boolean, message?:string}>} options.runOne
 *        单切片执行器；返回与 store 串行路径同构的 result 对象。
 * @param {(progress:{completed:number,total:number,concurrency:number,degraded:boolean,successCount:number,failedCount:number}) => void} [options.onProgress]
 *        进度回调；任意切片完成时触发。v18 扩展：携带 successCount / failedCount 供 UI 实时统计。
 * @param {AbortSignal} [options.signal]   外部取消信号（用户中途停止 / 切走页面）。
 * @returns {Promise<{
 *   results: Array,                      // 与 chunks 等长，每项 {ok, message?, status?}
 *   finalConcurrency: number,            // 收尾时的并发度（可能已降级到 1）
 *   initialConcurrency: number,          // 起始并发度（v18：供 UI 展示「已从 X 降到 Y」）
 *   degraded: boolean,                   // 是否触发过降级
 *   rateLimitCount: number,              // 限流错误数（429/503）——v18：UI 提示用
 *   failedIndexes: Array<number>,        // 失败切片下标（0-based）——v18：重试用
 *   successCount: number,                // 成功数
 * }>}
 *
 * 行为契约（不重试，与用户确认）：
 *   - 单切片失败（任何原因）→ 标 {ok:false, message}，不重试，不阻塞其它切片
 *   - 累计 RATE_LIMIT_WINDOW 个 429/503 → 立即把并发度降到 1，后续切片按串行执行
 *   - 降级一旦触发不再回升；保持「先稳后快」的策略
 *   - 总顺序：results[i] 始终对应 chunks[i]；与串行路径 100% 兼容
 */
export async function runAnalyzesInParallel({
  chunks,
  concurrency,
  runOne,
  onProgress,
  signal,
  paused = false,   // v20：初始暂停态（续跑时先暂停等用户「继续」）
  isPaused = () => false,  // v20：外部暂停查询器（刷新时恢复暂停态）
}) {
  const total = chunks.length;
  const initialConcurrency = clampConcurrency(concurrency);
  const results = new Array(total);
  const failedIndexes = [];
  let currentConcurrency = initialConcurrency;
  let rateLimitHits = 0;
  let degraded = false;
  let completed = 0;
  let successCount = 0;

  // v20：暂停信号。isPaused() 返回 true 时 worker 停在当前切片边界，
  // 不发起新请求；已完成的切片保留，`completed` 就是已持久化的进度。
  // v24.4.2：只读 isPaused()，不再 baked-in `paused` 参数；resumeTask 改 isPaused
  // 即可让原有 worker 继续，避免重调度造成双 executeTask。
  const shouldPause = () => isPaused();

  const fireProgress = () => {
    if (typeof onProgress === 'function') {
      onProgress({
        completed,
        total,
        concurrency: currentConcurrency,
        degraded,
        successCount,
        failedCount: failedIndexes.length,
        rateLimitCount: rateLimitHits,  // v18.1：透出实时限流计数，UI 实时徽章用
      });
    }
  };

  fireProgress();

  if (total === 0) {
    return {
      results,
      finalConcurrency: currentConcurrency,
      initialConcurrency,
      degraded,
      rateLimitCount: 0,
      failedIndexes,
      successCount: 0,
    };
  }

  // 简单 worker 池：维护 N 个工作槽，每个槽不断从队列里取下一个 chunk。
  // 用 AbortSignal 监听外部取消；signal 触发时所有未完成的 promise 用同样的 reason reject。
  const queue = chunks.map((chunk, index) => ({ chunk, index }));
  let nextIndex = 0;

  const isAborted = () => signal && signal.aborted;
  const abortError = () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
  };

  const takeNext = () => {
    if (isAborted() || shouldPause()) return null;
    if (nextIndex >= queue.length) return null;
    const item = queue[nextIndex];
    nextIndex += 1;
    return item;
  };

  const isRateLimitError = (result) => {
    if (!result || result.ok !== false) return false;
    const status = result.status;
    return typeof status === 'number' && RATE_LIMIT_STATUS.has(status);
  };

  const recordRateLimit = () => {
    if (degraded) return;
    rateLimitHits += 1;
    if (rateLimitHits >= RATE_LIMIT_WINDOW && currentConcurrency > MIN_CONCURRENCY) {
      currentConcurrency = MIN_CONCURRENCY;
      degraded = true;
    }
  };

  const handleResult = (index, result) => {
    results[index] = result;
    if (isRateLimitError(result)) recordRateLimit();
    if (result && result.ok === true) {
      successCount += 1;
    } else {
      failedIndexes.push(index);
    }
    completed += 1;
    fireProgress();
  };

  const worker = async () => {
    // v20：暂停时先原地等待，不退出 worker（退出会让结果被标成「未执行」）。
    while (!isAborted()) {
      if (shouldPause()) {
        // 等待 300ms，但若被 abort 则立即醒来——避免暂停中 abort 时卡死
        await Promise.race([
          new Promise((r) => setTimeout(r, 300)),
          ...(signal ? [new Promise((r) => signal.addEventListener('abort', r, { once: true }))] : []),
        ]);
        continue;
      }
      const item = takeNext();
      if (item === null) return;
      try {
        const result = await runOne(item.chunk, item.index, signal);
        handleResult(item.index, result);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          results[item.index] = { ok: false, message: '已取消' };
          failedIndexes.push(item.index);
          completed += 1;
          fireProgress();
          return;
        }
        // 抛异常不是分析结果格式 — 走失败通道，不计入限流
        results[item.index] = { ok: false, message: err && err.message ? err.message : String(err) };
        failedIndexes.push(item.index);
        completed += 1;
        fireProgress();
      }
    }
  };

  // 第一波：起 currentConcurrency 个 worker
  const initialWave = [];
  for (let i = 0; i < currentConcurrency; i += 1) initialWave.push(worker());
  await Promise.all(initialWave);

  // 降级后剩余任务（如果降级发生在第一波完成前，第一波 worker 用的就是降级前的并发度）
  // —— 重新检查队列，剩余切片单线程补完。
  // v20：暂停时这里也等待，不把剩余切片标成「未执行」。
  if (!isAborted() && nextIndex < queue.length) {
    while (nextIndex < queue.length) {
      if (isAborted()) break;
      if (shouldPause()) {
        // 同 worker 暂停等待：abort 时立即醒来避免卡死
        await Promise.race([
          new Promise((r) => setTimeout(r, 300)),
          ...(signal ? [new Promise((r) => signal.addEventListener('abort', r, { once: true }))] : []),
        ]);
        continue;
      }
      const item = queue[nextIndex];
      nextIndex += 1;
      try {
        const result = await runOne(item.chunk, item.index, signal);
        handleResult(item.index, result);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          results[item.index] = { ok: false, message: '已取消' };
          failedIndexes.push(item.index);
          completed += 1;
          fireProgress();
          break;
        }
        results[item.index] = { ok: false, message: err && err.message ? err.message : String(err) };
        failedIndexes.push(item.index);
        completed += 1;
        fireProgress();
      }
    }
  }

  // 任何未填充的槽位（被取消 / 队列空）补上占位
  for (let i = 0; i < total; i += 1) {
    if (results[i] === undefined) {
      results[i] = { ok: false, message: isAborted() ? '已取消' : '未执行' };
      failedIndexes.push(i);
    }
  }

  return {
    results,
    finalConcurrency: currentConcurrency,
    initialConcurrency,
    degraded,
    rateLimitCount: rateLimitHits,
    failedIndexes: failedIndexes.slice().sort((a, b) => a - b),
    successCount,
    paused: shouldPause(),   // v20：执行器因暂停而未完时置 true
    completed,               // v20：已完成的切片数（含失败）——续跑从它继续
  };
}

export function clampConcurrency(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return MIN_CONCURRENCY;
  if (n < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  if (n > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return n;
}

export const __TEST__ = { RATE_LIMIT_STATUS, RATE_LIMIT_WINDOW, MIN_CONCURRENCY, MAX_CONCURRENCY };