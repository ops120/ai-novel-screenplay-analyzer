import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeChunkResults,
  runAnalyzesInParallel,
  clampConcurrency,
  __TEST__,
} from './analysisFlow.js';

test('all chunks must succeed for the analysis to succeed', () => {
  assert.deepEqual(
    summarizeChunkResults([{ ok: true }, { ok: true }]),
    { successCount: 2, errorCount: 0, failedIndexes: [], ok: true, message: '' },
  );
});

test('a failed chunk makes the whole analysis fail with its index and message', () => {
  const summary = summarizeChunkResults([
    { ok: true },
    { ok: false, message: '模型响应超时' },
  ]);

  assert.equal(summary.successCount, 1);
  assert.equal(summary.errorCount, 1);
  assert.deepEqual(summary.failedIndexes, [1]);
  assert.equal(summary.ok, false);
  assert.match(summary.message, /切片 2/);
  assert.match(summary.message, /模型响应超时/);
});

// ==================== v17：clampConcurrency ====================

test('clampConcurrency 把越界值压到 1—8 范围', () => {
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(-5), 1);
  assert.equal(clampConcurrency(3), 3);
  assert.equal(clampConcurrency(99), __TEST__.MAX_CONCURRENCY);
  assert.equal(clampConcurrency('abc'), 1);
  assert.equal(clampConcurrency(undefined), 1);
  assert.equal(clampConcurrency(null), 1);
  // 字符串数字也要接受
  assert.equal(clampConcurrency('5'), 5);
});

// ==================== v17：runAnalyzesInParallel ====================

// 把 N 个 chunk 的「请求」变成可手动驱动的 promise 序列
function makeRunners(latencies) {
  // latencies[i] = 该 chunk 完成所需的毫秒
  return latencies.map((latency, index) => async () => {
    await new Promise((resolve) => setTimeout(resolve, latency));
    return { ok: true, index };
  });
}

test('并发执行器：results 顺序与 chunks 一致（不按完成顺序排列）', async () => {
  const chunks = [0, 1, 2, 3, 4];
  // 故意让 index 0 最慢，index 4 最快
  const runners = makeRunners([50, 40, 30, 20, 10]);
  const { results, finalConcurrency, degraded } = await runAnalyzesInParallel({
    chunks,
    concurrency: 3,
    runOne: (_chunk, index) => runners[index](),
  });
  assert.equal(degraded, false);
  assert.equal(finalConcurrency, 3);
  assert.equal(results.length, 5);
  // 每个 results[i].index 必须 == i —— 验证顺序契约
  for (let i = 0; i < 5; i += 1) {
    assert.equal(results[i].ok, true);
    assert.equal(results[i].index, i);
  }
});

test('并发执行器：失败切片标 {ok:false, message}，不影响其它切片', async () => {
  const { results } = await runAnalyzesInParallel({
    chunks: [0, 1, 2],
    concurrency: 3,
    runOne: async (_c, index) => {
      if (index === 1) return { ok: false, message: '模型 422', status: 422 };
      return { ok: true };
    },
  });
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.equal(results[1].message, '模型 422');
  assert.equal(results[1].status, 422);
});

test('并发执行器：连续 3 次 429/503 触发降级到 1', async () => {
  let callIndex = 0;
  const { results, finalConcurrency, degraded } = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4, 5, 6],
    concurrency: 5,
    runOne: async () => {
      callIndex += 1;
      // 前 3 次都是 429，第 4 次开始 200
      if (callIndex <= 3) return { ok: false, message: 'rate limited', status: 429 };
      return { ok: true };
    },
  });
  assert.equal(degraded, true);
  assert.equal(finalConcurrency, 1);
  // 7 个切片的结果总数对
  assert.equal(results.length, 7);
  // 至少 3 个标了 429
  const limited = results.filter((r) => r.status === 429).length;
  assert.ok(limited >= 3, `expected at least 3 429 responses, got ${limited}`);
});

test('并发执行器：3 次 503 也算限流（与 429 同语义）', async () => {
  const { degraded, finalConcurrency } = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3],
    concurrency: 4,
    runOne: async (_c, index) => {
      if (index < 3) return { ok: false, message: 'overloaded', status: 503 };
      return { ok: true };
    },
  });
  assert.equal(degraded, true);
  assert.equal(finalConcurrency, 1);
});

test('并发执行器：非限流错误（4xx 非 429、5xx 非 503）不计入降级统计', async () => {
  const { degraded, finalConcurrency } = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3],
    concurrency: 4,
    runOne: async (_c, index) => {
      // 422 是请求体问题，不是限流——不该触发降级
      if (index < 3) return { ok: false, message: 'bad request', status: 422 };
      return { ok: true };
    },
  });
  assert.equal(degraded, false);
  assert.equal(finalConcurrency, 4);
});

test('并发执行器：降级一旦触发不再回升（即使后续切片都成功）', async () => {
  // 5 个并发，前 3 个失败触发降级到 1，后续 4 个都成功
  const { degraded, finalConcurrency, results } = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4, 5, 6],
    concurrency: 5,
    runOne: async (_c, index) => {
      if (index < 3) return { ok: false, message: 'rl', status: 429 };
      return { ok: true };
    },
  });
  assert.equal(degraded, true);
  assert.equal(finalConcurrency, 1);
  assert.equal(results[3].ok, true);
  assert.equal(results[6].ok, true);
});

test('并发执行器：onProgress 回调按完成数触发，progress 字段单调不减', async () => {
  const progressHistory = [];
  await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4],
    concurrency: 3,
    runOne: async (_c, index) => {
      // 后置慢、前置快——必须等所有完成才让最后一次 progress = total
      await new Promise((r) => setTimeout(r, index === 4 ? 30 : 5));
      return { ok: true };
    },
    onProgress: (p) => progressHistory.push(p.completed),
  });
  // 初次 fireProgress → 0 / N
  assert.equal(progressHistory[0], 0);
  // 单调不减
  for (let i = 1; i < progressHistory.length; i += 1) {
    assert.ok(progressHistory[i] >= progressHistory[i - 1],
      `progress decreased at ${i}: ${progressHistory[i - 1]} -> ${progressHistory[i]}`);
  }
  // 末尾一定达到 total
  assert.equal(progressHistory[progressHistory.length - 1], 5);
});

test('并发执行器：外部 AbortSignal 中断时未完成切片标"已取消"', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const { results } = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    concurrency: 5,
    runOne: async (_c, index) => {
      // 每个 chunk 100ms，远大于 abort 延迟
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true };
    },
    signal: controller.signal,
  });
  // 所有切片都应该有结果（不是 undefined）
  assert.equal(results.length, 10);
  for (const r of results) {
    assert.ok(r !== undefined, 'no undefined slot allowed');
  }
  // 至少 1 个被标"已取消"
  const cancelled = results.filter((r) => r.message === '已取消').length;
  assert.ok(cancelled > 0, `expected at least 1 cancelled, got ${cancelled}`);
});

test('并发执行器：空 chunks 数组直接返回空 results', async () => {
  const { results, finalConcurrency, degraded } = await runAnalyzesInParallel({
    chunks: [],
    concurrency: 3,
    runOne: async () => ({ ok: true }),
  });
  assert.deepEqual(results, []);
  assert.equal(finalConcurrency, 3);
  assert.equal(degraded, false);
});

test('并发执行器：concurrency=1 等同串行（行为兼容）', async () => {
  // 串行路径的契约：results[i] 对应 chunks[i]，失败的 message 正确
  const { results, finalConcurrency, degraded } = await runAnalyzesInParallel({
    chunks: [0, 1, 2],
    concurrency: 1,
    runOne: async (_c, index) => {
      if (index === 1) return { ok: false, message: 'boom' };
      return { ok: true };
    },
  });
  assert.equal(finalConcurrency, 1);
  assert.equal(degraded, false);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.equal(results[1].message, 'boom');
});

test('runOne 抛异常（非 AbortError）走失败通道，标记 message', async () => {
  const { results } = await runAnalyzesInParallel({
    chunks: [0, 1, 2],
    concurrency: 3,
    runOne: async (_c, index) => {
      if (index === 1) throw new Error('fetch failed: ECONNRESET');
      return { ok: true };
    },
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].message, /ECONNRESET/);
  assert.equal(results[2].ok, true);
});

// ==================== v18：失败信息 / 限流 / 重试数据 ====================

test('v18：runAnalyzesInParallel 返回值包含 failedIndexes / rateLimitCount / initialConcurrency / successCount', async () => {
  const result = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4],
    concurrency: 3,
    runOne: async (_c, index) => {
      if (index === 1 || index === 3) return { ok: false, message: '限流', status: 429 };
      if (index === 4) return { ok: false, message: '其他错', status: 500 };
      return { ok: true };
    },
  });
  assert.equal(result.successCount, 2);
  assert.equal(result.rateLimitCount, 2);  // 1 和 3 都是 429
  assert.deepEqual(result.failedIndexes, [1, 3, 4]);
  assert.equal(result.initialConcurrency, 3);
  // 2 次 429 < 阈值 3 → 不降级
  assert.equal(result.degraded, false);
  assert.equal(result.finalConcurrency, 3);
});

test('v18：限流次数严格按 RATE_LIMIT_WINDOW 触发降级', async () => {
  // 用一个隔离的小阈值：连续 3 次才降级
  // 默认窗口是 3，前 2 次只增计数不降级
  const onlyTwoRateLimit = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3],
    concurrency: 4,
    runOne: async (_c, index) => {
      if (index < 2) return { ok: false, message: 'rl', status: 429 };
      return { ok: true };
    },
  });
  assert.equal(onlyTwoRateLimit.rateLimitCount, 2);
  assert.equal(onlyTwoRateLimit.degraded, false);
  assert.equal(onlyTwoRateLimit.finalConcurrency, 4);
});

test('v18：onProgress 回调携带 successCount / failedCount', async () => {
  const history = [];
  await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4],
    concurrency: 3,
    runOne: async (_c, index) => {
      // 第 2 片失败
      if (index === 2) return { ok: false, message: 'x' };
      return { ok: true };
    },
    onProgress: (p) => history.push({ success: p.successCount, failed: p.failedCount }),
  });
  // 最后一次一定成功 4 失败 1
  const last = history[history.length - 1];
  assert.equal(last.success, 4);
  assert.equal(last.failed, 1);
  // 单调性：success + failed = completed = i+1
  for (let i = 0; i < history.length; i += 1) {
    assert.equal(history[i].success + history[i].failed, i);
  }
});

test('v18：failedIndexes 按 0-based 下标返回，UI 重试用', async () => {
  const result = await runAnalyzesInParallel({
    chunks: ['a', 'b', 'c', 'd', 'e'],
    concurrency: 1,  // 串行方便断言顺序
    runOne: async (_c, index) => {
      // 失败发生在 1、3、4 —— 验证下标正确
      if (index === 1 || index === 3 || index === 4) {
        return { ok: false, message: 'x' };
      }
      return { ok: true };
    },
  });
  assert.deepEqual(result.failedIndexes, [1, 3, 4]);
  // 排序：内部应已排好
  const sorted = [...result.failedIndexes].sort((a, b) => a - b);
  assert.deepEqual(result.failedIndexes, sorted);
});

test('v18：限流窗口外的中途 503 不重复计 rateLimitCount（每次失败只算一次）', async () => {
  // 5 片，并发 5；前 2 个 503，后 3 个成功 → rateLimitCount=2
  const result = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4],
    concurrency: 5,
    runOne: async (_c, index) => {
      if (index < 2) return { ok: false, message: 'overload', status: 503 };
      return { ok: true };
    },
  });
  assert.equal(result.rateLimitCount, 2);
  assert.equal(result.successCount, 3);
  assert.equal(result.degraded, false);  // 2 < 3 不触发
});

// ==================== v18.1：onProgress 必须自带 rateLimitCount（修 TDZ）=================

test('v18.1：onProgress 回调每片都带 rateLimitCount 字段，UI 不依赖外层 await 解构', async () => {
  // 真实场景：store.js 里 onProgress 同步触发多次，外层 await 解构的变量还在 TDZ。
  // —— 必须靠回调自己带 rateLimitCount，而不是闭包捕获外层。
  const progressHistory = [];
  await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4, 5],
    concurrency: 3,
    runOne: async (_c, index) => {
      if (index === 0) return { ok: false, message: 'rl', status: 429 };
      if (index === 2) return { ok: false, message: 'rl', status: 429 };
      if (index === 4) return { ok: false, message: 'rl', status: 429 };
      return { ok: true };
    },
    onProgress: (p) => progressHistory.push(p),
  });
  // 每次 progress 都必须有 rateLimitCount 数字字段（不依赖外层）
  for (const p of progressHistory) {
    assert.equal(typeof p.rateLimitCount, 'number',
      `progress.rateLimitCount 应为 number, 实际 ${typeof p.rateLimitCount} (${p.rateLimitCount})`);
    assert.ok(p.rateLimitCount >= 0);
  }
  // 单调不减：触发 3 次 429 后，末尾应达到 3
  const last = progressHistory[progressHistory.length - 1];
  assert.equal(last.rateLimitCount, 3);
  // 中间进度不会「跳」到最终值
  for (let i = 0; i < progressHistory.length; i += 1) {
    assert.ok(progressHistory[i].rateLimitCount <= last.rateLimitCount);
  }
});

// ==================== v20：暂停 / 续跑 ====================

test('v20：isPaused 为 true 时执行器停在切片边界，abort 后返回 paused=true 且 completed=0', async () => {
  const ac = new AbortController();
  // 先调度 abort（Promise 构造时 setTimeout 才排进微任务队列；这里用 setTimeout 确保在 await 前入队）
  setTimeout(() => ac.abort(), 50);
  let runOneCalls = 0;
  const { results, paused: resultPaused, completed } = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4],
    concurrency: 3,
    signal: ac.signal,
    isPaused: () => true,  // 永远暂停
    runOne: async (_c, index) => {
      runOneCalls += 1;
      return { ok: true, index };
    },
  });
  // abort 后 workers 应在下次暂停等待时立即醒来并退出
  assert.equal(resultPaused, true);
  assert.equal(completed, 0, '暂停中不应有切片真正完成');
  // 暂停态下 runOne 从未被调用
  assert.equal(runOneCalls, 0, '暂停中不应调用 runOne');
});

test('v20：先暂停再 unpause，执行器能跑完全部切片', async () => {
  let paused = true;
  const ac = new AbortController();
  setTimeout(() => { paused = false; }, 200);  // 200ms 后恢复
  const { results, completed } = await runAnalyzesInParallel({
    chunks: [0, 1, 2, 3, 4],
    concurrency: 3,
    signal: ac.signal,
    isPaused: () => paused,
    runOne: async (_c, index) => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, index };
    },
  });
  // 恢复后应全部跑完
  assert.equal(results.length, 5);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(results[i].ok, true);
    assert.equal(results[i].index, i);
  }
  assert.equal(completed, 5);
});

test('v20：执行器返回值包含 paused 和 completed 字段', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const { paused: resultPaused, completed } = await runAnalyzesInParallel({
    chunks: [0, 1, 2],
    concurrency: 3,
    signal: ac.signal,
    isPaused: () => true,
    runOne: async () => ({ ok: true }),
  });
  assert.equal(typeof resultPaused, 'boolean');
  assert.equal(typeof completed, 'number');
});

test('v27：getMaxConcurrency 调大后 worker 池补充（实时加并发）', async () => {
  let max = 2;
  let inFlight = 0;
  let peakInFlight = 0;
  const runOne = async () => {
    inFlight += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    await new Promise((r) => setTimeout(r, 40));
    inFlight -= 1;
    return { ok: true };
  };
  // 第一波只起 2 个；~120ms 后加到 5，池应补充
  setTimeout(() => { max = 5; }, 100);
  const result = await runAnalyzesInParallel({
    chunks: Array.from({ length: 16 }, (_, i) => i),
    concurrency: 2,
    getMaxConcurrency: () => max,
    runOne,
  });
  assert.equal(result.successCount, 16);
  // 加到 5 后有机会并发到 5；peakInFlight 应 ≥ 2（初始上限）
  assert.ok(peakInFlight >= 2, `peakInFlight=${peakInFlight} 应 ≥ 2`);
  assert.ok(peakInFlight <= 5, `peakInFlight=${peakInFlight} 不应 > 5`);
});

test('v27：getMaxConcurrency 调大不超过新上限（实时加并发不过头）', async () => {
  let max = 1;
  let inFlight = 0;
  let peakInFlight = 0;
  const runOne = async () => {
    inFlight += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    await new Promise((r) => setTimeout(r, 30));
    inFlight -= 1;
    return { ok: true };
  };
  setTimeout(() => { max = 3; }, 60);
  const result = await runAnalyzesInParallel({
    chunks: Array.from({ length: 12 }, (_, i) => i),
    concurrency: 1,
    getMaxConcurrency: () => max,
    runOne,
  });
  assert.equal(result.successCount, 12);
  assert.ok(peakInFlight <= 3, `peakInFlight=${peakInFlight} 不应 > 3`);
  assert.ok(peakInFlight >= 2, `peakInFlight=${peakInFlight} 应 ≥ 2（从 1 加到 3 后需要起多个 worker）`);
});


test('v27-fix: 降级触发后池子上限降到 1，新取片不再超 cap', async () => {
  // 并发 4，10 个切片；前 3 个 429 触发降级。
  // 验证：finalConcurrency=1；总处理数=10；后续切片严格串行。
  // 瞬态（降级瞬间已有 worker 在飞）是允许的 —— worker 必须等当前 chunk 跑完才能退出。
  const startTimes = [];
  const runOne = async (_chunk, index) => {
    startTimes[index] = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    if (index < 3) return { ok: false, message: 'rate limited', status: 429 };
    return { ok: true };
  };

  const result = await runAnalyzesInParallel({
    chunks: Array.from({ length: 10 }, (_, i) => i),
    concurrency: 4,
    runOne,
  });

  assert.equal(result.degraded, true);
  assert.equal(result.finalConcurrency, 1);
  assert.equal(result.successCount + result.failedIndexes.length, 10);
  // 关键：index >= 3 的切片必须串行（一个跑完才开始下一个），证明 cap=1 生效。
  for (let i = 1; i < 10; i += 1) {
    const prev = startTimes[i - 1];
    const cur = startTimes[i];
    assert.ok(cur >= prev, `chunk ${i} 应在 chunk ${i - 1} 之后开始`);
  }
});

test('v27-fix: 降级后 getMaxConcurrency 回调被忽略，cap 永久为 1', async () => {
  // 即便 getMaxConcurrency() 始终返回 5，cap 也得是 1（degraded 优先）。
  // 验证：startTimes 单调不减 → 串行执行 → cap 实际生效。
  const max = 5;
  const startTimes = [];
  const runOne = async (_chunk, index) => {
    startTimes[index] = Date.now();
    await new Promise((r) => setTimeout(r, 15));
    if (index < 3) return { ok: false, message: 'rate limited', status: 429 };
    return { ok: true };
  };

  const result = await runAnalyzesInParallel({
    chunks: Array.from({ length: 8 }, (_, i) => i),
    concurrency: 4,
    getMaxConcurrency: () => max,
    runOne,
  });

  assert.equal(result.degraded, true);
  assert.equal(result.finalConcurrency, 1);
  for (let i = 1; i < 8; i += 1) {
    const prev = startTimes[i - 1];
    const cur = startTimes[i];
    assert.ok(cur >= prev, `chunk ${i} 应在 chunk ${i - 1} 之后开始`);
  }
});
