// v24：炼化任务后台化 + 任务管理面板。
//
// 设计：
// - 任务独立于 currentProjectId，可在后台跑；切换项目不影响任务执行。
// - 复用 v17—v20 已稳定的 analysisFlow 并发执行器 + AbortSignal 暂停门控。
// - 失败切片、进度、统计、模型名、章节范围全部挂在 task 上，供 TaskPanel 渲染。
// - 通过 subscribe(fn) 暴露变更，store / UI 订阅后驱动 React 重渲染。
// - 任务本身不持久化（不写 localStorage）。重启后用 progressStore / failureStore 续跑，
//   与 v20 设计一致。
//
// 任务状态机：
//   idle → running ⇄ paused → completed | failed | cancelled
//
// 调用方（store / 组件）通过：
//   createAnalyzeTask / createContinueTask / createRetryFailedTask 启动
//   pauseTask(id) / resumeTask(id) / cancelTask(id) 操作
//   getTasksSnapshot() / subscribe(fn) 订阅

import {
  runAnalyzesInParallel,
  clampConcurrency,
} from './analysisFlow.js';
import { detectChapterRanges, splitTextWithChapterContext } from './chapterSplitter.js';
import { API_BASE } from './config.js';
import { saveFailure, clearFailure, getFailure } from './failureStore.js';
import {
  saveProgress,
  updateProgress,
  clearProgress,
  listProgress,
} from './progressStore.js';

// v24：每个 projectId 同时只允许一个 active 任务（不限项目）。
// 多项目并行的并发上限：默认 3，与 v17 默认并发度对齐；超出排队。
const MAX_PARALLEL_TASKS = 3;

// 状态机允许的终态：取消/完成/失败之后不再启动。
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
// v24.4.2：active = 真正占并发槽（running / paused）。idle = 排队等待，不占槽。
const ACTIVE_STATUSES = new Set(['running', 'paused']);
const PAUSED_STATUSES = new Set(['paused']);
// v25：interrupted = 刷新后从 progressStore 恢复的「展示态」记录。它没有 Promise /
// AbortController / 切片执行器，只用于展示与「继续」入口，因此既不占并发槽，
// 也不能参与项目锁 —— 否则会挡住真正的续跑任务创建。
const NON_LOCKING_STATUSES = new Set([...TERMINAL_STATUSES, 'interrupted']);

// 等待启动的任务队列（FIFO）。setInterval 已被 pumpQueue 取代。
const pendingQueue = [];

// ---------------- task 状态 ----------------

let _seq = 0;
function nextTaskId() {
  _seq += 1;
  return `task_${Date.now().toString(36)}_${_seq}`;
}

function makeTaskRecord(opts) {
  const initial = clampConcurrency(opts.concurrency ?? 3);
  return {
    id: opts.id,
    kind: opts.kind,           // 'analyze' | 'continue' | 'retry'
    projectId: opts.projectId,
    projectName: opts.projectName || '',
    modelName: opts.modelName || '',
    status: 'idle',
    total: opts.total || 0,
    overallTotal: opts.overallTotal || opts.total || 0,  // retry 时 = 原文全局切片总数
    completed: 0,
    successCount: 0,
    failedCount: 0,
    rateLimitCount: 0,
    degraded: false,
    initialConcurrency: initial,            // v17：起始并发度（不随降级变化）
    currentConcurrency: initial,            // v18：当前并发度（降级后会变）
    chapterFrom: opts.chapterFrom || '',
    chapterTo: opts.chapterTo || '',
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
    errorMessage: '',
    failedChunks: [],          // [{chunkIndex, message, status}]
    chunks: [],                // 切片文本（不持久化，内存）
    chunkMetas: [],            // [{text, chapter, chunkIndex}]
    startIndex: 0,             // continue 时从哪个 chunkIndex 开始；retry=0
    abortController: null,
    isPaused: false,
    resolve: null,             // Promise resolve（finish/cancel 时调）
    reject: null,
    promise: null,
    onChangeSubscribers: new Set(),
    _suppressNotify: false,
  };
}

// ---------------- 全局 task map + 订阅 ----------------

const tasks = new Map();
const globalSubscribers = new Set();

function notifyTask(task) {
  for (const fn of task.onChangeSubscribers) {
    try { fn(task); } catch (e) { console.warn('task subscriber failed', e); }
  }
  for (const fn of globalSubscribers) {
    try { fn(task); } catch (e) { console.warn('global task subscriber failed', e); }
  }
}

function updateTask(task, patch) {
  Object.assign(task, patch);
  notifyTask(task);
}

// 计算当前活跃任务数（用于 MAX_PARALLEL_TASKS 限流）
function activeTaskCount() {
  let n = 0;
  for (const t of tasks.values()) {
    if (ACTIVE_STATUSES.has(t.status)) n += 1;
  }
  return n;
}

// v24.0.1：每个 projectId 同一时刻最多一个任务（含排队）。
// 多项目并行的并发上限由 MAX_PARALLEL_TASKS 统一约束。
// v25：interrupted 恢复项不参与项目锁（见 NON_LOCKING_STATUSES 注释）。
function hasActiveTaskForProject(projectId) {
  if (!projectId) return false;
  for (const t of tasks.values()) {
    if (t.projectId === projectId && !NON_LOCKING_STATUSES.has(t.status)) return true;
  }
  return false;
}

// v25：把某项目的 interrupted 恢复项摘掉。只在真正的续跑任务构造成功后调用，
// 保证「构造失败 → 恢复项原样保留」。
function removeInterruptedForProject(projectId) {
  if (!projectId) return;
  for (const t of Array.from(tasks.values())) {
    if (t.projectId === projectId && t.status === 'interrupted') {
      tasks.delete(t.id);
      notifyTask(t);
    }
  }
}

// v24.0.1：显式 FIFO 队列 + pumpQueue 取代 setInterval，避免定时器泄漏。
function pumpQueue() {
  while (pendingQueue.length > 0 && activeTaskCount() < MAX_PARALLEL_TASKS) {
    const task = pendingQueue.shift();
    if (!task || !tasks.has(task.id)) continue;
    if (TERMINAL_STATUSES.has(task.status)) continue;
    if (ACTIVE_STATUSES.has(task.status) && task.status !== 'idle') continue;
    task._queued = false;
    executeTask(task).catch((e) => console.error('executeTask 异常', e));
  }
}

function scheduleTask(task) {
  if (activeTaskCount() < MAX_PARALLEL_TASKS) {
    executeTask(task).catch((e) => console.error('executeTask 异常', e));
  } else if (!task._queued) {
    task._queued = true;
    pendingQueue.push(task);
  }
}

// ---------------- 切片构造 ----------------

function buildChunks(text, chunkSize, chapterFrom, chapterTo) {
  let chunkMetas = splitTextWithChapterContext(text, chunkSize);
  const from = Number(chapterFrom);
  const to = Number(chapterTo);
  if (chapterFrom || chapterTo) {
    const ranges = detectChapterRanges(text);
    const validFrom = Number.isFinite(from) && from >= 1 ? Math.floor(from) : 0;
    const validTo = Number.isFinite(to) && to >= 1 ? Math.floor(to) : 0;
    chunkMetas = chunkMetas.filter((meta) => {
      const start = meta.chunkIndex * chunkSize;
      let chapterIdx = 0;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges[i].start <= start) chapterIdx = i + 1;
        else break;
      }
      if (validFrom && chapterIdx < validFrom) return false;
      if (validTo && chapterIdx > validTo) return false;
      return true;
    });
  }
  return chunkMetas;
}

// ---------------- 任务执行 ----------------

async function executeTask(task) {
  const { projectId, modelId, systemPrompt, chunkSize, concurrency } = task;
  const total = task.chunks.length;

  if (total === 0) {
    updateTask(task, { status: 'completed', finishedAt: Date.now(), progress: 100 });
    task.resolve?.({ successCount: 0, failedCount: 0 });
    return;
  }

  task.abortController = new AbortController();
  task.status = 'running';
  task.startedAt = Date.now();
  notifyTask(task);

  // v25-fix：先成功落盘，再发任何 LLM 请求。
  // 之前 v24 用 localStorage，setItem 抛 QuotaExceededError 被吞掉——刷新就丢断点。
  // 现在 PUT /api/task-progress/{id} 走 64MB 通道，但仍必须 await；失败时拒绝启动，
  // 否则刷新又会出现「任务管理里什么都没跑过」的诡异空白。
  if (task.kind !== 'retry') {
    try {
      await saveProgress(projectId, {
        totalChunks: task.startIndex + total,
        lastCompleted: task.startIndex,
        text: task.text || '',
        chunkSize,
        concurrency: clampConcurrency(concurrency),
        llmModelName: task.modelName || '',
        chapterFrom: task.chapterFrom || '',
        chapterTo: task.chapterTo || '',
      });
    } catch (err) {
      // 落盘失败：放弃本次启动，回滚 status + 释放并发槽，让上层决定如何提示用户。
      updateTask(task, {
        status: 'failed',
        isPaused: false,
        finishedAt: Date.now(),
        errorMessage: `进度断点落盘失败：${err && err.message ? err.message : String(err)}`,
      });
      task.reject?.(err);
      pumpQueue();
      return;
    }
  }

  const runOne = async (chunk, index) => {
    const meta = task.chunkMetas[task.startIndex + index];
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: modelId,
          text: chunk,
          system_prompt: systemPrompt,
          chunk_index: meta?.chunkIndex ?? index,
          chunk_size: chunkSize,
          chunk_chapter: meta?.chapter || '',
        }),
        signal: task.abortController.signal,
      });
      const r = await res.json().catch(() => ({}));
      if (res.ok && r.status === 'success') return { ok: true };
      return {
        ok: false,
        message: r.message || r.detail?.message || `HTTP ${res.status}`,
        status: res.status,
        chunkIndex: meta?.chunkIndex ?? index,
      };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, message: '已取消', status: -1, chunkIndex: meta?.chunkIndex ?? index };
      }
      return { ok: false, message: err && err.message ? err.message : String(err), chunkIndex: meta?.chunkIndex ?? index };
    }
  };

  const onProgress = (p) => {
    const lastCompleted = task.startIndex + p.completed;
    updateTask(task, {
      completed: p.completed,
      successCount: p.successCount,
      failedCount: p.failedCount,
      rateLimitCount: p.rateLimitCount,
      degraded: p.degraded,
      currentConcurrency: p.concurrency,
      progress: Math.round((p.completed / total) * 100),
    });
    // v24.4.3：retry 不写 progressStore。
    // retry 的 p.completed 是「重试目标数」（小），写到 progressStore 后会污染
    // 后续 continueAnalysis 的 lastCompleted —— continue 会误从 chunkMetas.slice(N)
    // 续跑，把 retry 失败片当成「已炼化」跳过。
    // 只有 analyze / continue 写 progressStore。
    if (task.kind === 'retry') return;
    // v25-fix：进度更新走 PATCH（不重传整篇原文）。后端 MAX 兜单调不回退。
    // fire-and-forget：失败仅记录，不阻塞 LLM 推进；最后清理时若发现 progressStore
    // 缺失，再让 store 层主动补救。
    //
    // 透传 abort signal：任务被取消后，fireProgress 还会触发一次（汇总结果）；
    // 不传 signal 会让已取消的请求继续打后端，触发「刷新后进度回退」之类的诡异 bug。
    updateProgress(projectId, { lastCompleted }, task.abortController?.signal).catch((e) => {
      // abort 期间失败属预期（任务已取消），不刷警告噪音
      if (e && (e.name === 'AbortError' || /aborted/i.test(String(e?.message || '')))) return;
      console.warn('updateProgress 失败', e);
    });
  };

  try {
    const result = await runAnalyzesInParallel({
      chunks: task.chunks,
      concurrency: clampConcurrency(concurrency),
      runOne,
      onProgress,
      signal: task.abortController.signal,
      isPaused: () => task.isPaused,
      paused: task.isPaused,
    });

    // 收集失败切片（retry 任务用全局 chunkIndex；continue 同 analyze；analyze 同 chunkIndex）
    const failed = [];
    result.results.forEach((r, i) => {
      if (!r || r.ok !== true) {
        const meta = task.chunkMetas[i];  // v24.0.1：retry 已把 chunkMetas 局部化为目标子集，i 即局部索引
        failed.push({
          chunkIndex: meta?.chunkIndex ?? (task.startIndex + i),
          message: r?.message || '未知错误',
          status: r?.status,
        });
      }
    });

    // v24.0.1：终态判定顺序——先 abort 再 paused，避免「暂停后取消」被写回 paused
    if (task.abortController.signal.aborted) {
      updateTask(task, {
        status: 'cancelled',
        isPaused: false,
        finishedAt: Date.now(),
        failedChunks: failed,
      });
      task.resolve?.({ cancelled: true, successCount: result.successCount, failedCount: failed.length });
      pumpQueue();
      return;
    }

    if (task.isPaused || result.paused) {
      updateTask(task, { status: 'paused', isPaused: true, failedChunks: failed });
      task.resolve?.({ paused: true, lastCompleted: task.startIndex + result.completed });
      pumpQueue();
      return;
    }

    // 失败切片落 failureStore（v18 兼容：只有 analyze / retry 写）
    if (task.kind !== 'continue' && failed.length > 0) {
      saveFailure(projectId, {
        totalChunks: task.overallTotal,  // v24.0.1：保持原文全局切片总数，与 failed[].chunkIndex 同一坐标系
        chunks: failed,
        text: task.text || '',
        chunkSize,
        chapterFrom: task.chapterFrom || '',
        chapterTo: task.chapterTo || '',
      });
    } else if (failed.length === 0) {
      clearFailure(projectId);
    }

    updateTask(task, {
      status: failed.length > 0 ? 'failed' : 'completed',
      isPaused: false,
      finishedAt: Date.now(),
      failedChunks: failed,
    });
    // v24.4.3：retry 不动 progressStore（retry 从未写过它）
    if (failed.length === 0 && task.kind !== 'retry') {
      // 本地断点删除完成后再 resolve，避免完成瞬间刷新时旧断点短暂复活。
      try {
        await clearProgress(projectId);
      } catch (error) {
        console.warn('clearProgress 失败', error);
      }
    }
    task.resolve?.({
      successCount: result.successCount,
      failedCount: failed.length,
    });
    pumpQueue();
  } catch (err) {
    console.error('executeTask 异常', err);
    updateTask(task, {
      status: 'failed',
      isPaused: false,
      finishedAt: Date.now(),
      errorMessage: err && err.message ? err.message : String(err),
    });
    task.reject?.(err);
    pumpQueue();
  }
}

// ---------------- 公共 API ----------------

/**
 * 创建并启动一次「全新」炼化任务（按文本切片，从头开始）。
 * 同 projectId 已有 active 任务时返回 null（拒绝并发）。
 */
export function createAnalyzeTask(opts) {
  if (!opts || !opts.projectId) return null;
  if (hasActiveTaskForProject(opts.projectId)) return null;

  const id = nextTaskId();
  const task = makeTaskRecord({
    id,
    kind: 'analyze',
    projectId: opts.projectId,
    projectName: opts.projectName,
    modelName: opts.modelName,
    concurrency: opts.concurrency,
    chapterFrom: opts.chapterFrom,
    chapterTo: opts.chapterTo,
  });
  task.text = opts.text;
  task.modelId = opts.modelId;
  task.systemPrompt = opts.systemPrompt;
  task.chunkSize = opts.chunkSize;

  const chunkMetas = buildChunks(opts.text, opts.chunkSize, opts.chapterFrom, opts.chapterTo);
  task.chunkMetas = chunkMetas;
  task.chunks = chunkMetas.map((c) => c.text);
  task.total = chunkMetas.length;
  task.overallTotal = chunkMetas.length;
  task.startIndex = 0;

  task.promise = new Promise((resolve, reject) => {
    task.resolve = resolve;
    task.reject = reject;
  });

  // v25：与 createContinueTask 同语义 —— 全部构造成功后才替换掉恢复项。
  removeInterruptedForProject(opts.projectId);

  tasks.set(id, task);
  notifyTask(task);
  scheduleTask(task);
  return task;
}

/**
 * 创建并启动「续跑」任务。从 progressStore 读上次进度。
 * @returns {object|null} task；若无可续跑进度返回 null
 */
export function createContinueTask(opts) {
  if (!opts || !opts.projectId) return null;
  if (hasActiveTaskForProject(opts.projectId)) return null;

  const { progress } = opts;
  if (!progress || !progress.active || progress.lastCompleted >= progress.totalChunks) return null;
  const text = progress.text;
  if (!text) return null;
  const chunkMetas = buildChunks(text, progress.chunkSize, progress.chapterFrom, progress.chapterTo);
  const start = progress.lastCompleted;
  const remainingMetas = chunkMetas.slice(start);
  if (remainingMetas.length === 0) return null;

  const id = nextTaskId();
  const task = makeTaskRecord({
    id,
    kind: 'continue',
    projectId: opts.projectId,
    projectName: opts.projectName || '',
    modelName: opts.modelName,
    concurrency: progress.concurrency,
    chapterFrom: progress.chapterFrom,
    chapterTo: progress.chapterTo,
    total: remainingMetas.length,
    overallTotal: chunkMetas.length,  // v24.0.1：原文全局切片总数
  });
  task.text = text;
  task.modelId = opts.modelId;
  task.systemPrompt = opts.systemPrompt;
  task.chunkSize = progress.chunkSize;
  task.chunkMetas = chunkMetas;
  task.chunks = remainingMetas.map((c) => c.text);
  task.startIndex = start;

  task.promise = new Promise((resolve, reject) => {
    task.resolve = resolve;
    task.reject = reject;
  });

  // v25：所有校验与任务记录构造都已成功，此刻才替换掉恢复项。
  removeInterruptedForProject(opts.projectId);

  tasks.set(id, task);
  notifyTask(task);
  scheduleTask(task);
  return task;
}

/**
 * 创建并启动「重试失败切片」任务。从 failureStore 读失败记录。
 * @returns {object|null} task
 */
export function createRetryFailedTask(opts) {
  if (!opts || !opts.projectId) return null;
  if (hasActiveTaskForProject(opts.projectId)) return null;

  const failure = getFailure(opts.projectId);
  if (!failure || failure.chunks.length === 0) return null;
  const text = failure.text;
  if (!text) return null;
  const chunkMetas = buildChunks(text, failure.chunkSize, failure.chapterFrom, failure.chapterTo);
  const targets = failure.chunks
    .map((c) => ({ failure: c, meta: chunkMetas.find((m) => m.chunkIndex === c.chunkIndex) }))
    .filter((t) => t.meta);
  if (targets.length === 0) return null;

  const id = nextTaskId();
  const task = makeTaskRecord({
    id,
    kind: 'retry',
    projectId: opts.projectId,
    projectName: opts.projectName || '',
    modelName: opts.modelName,
    concurrency: 1,  // v18：重试串行，避免再次打挂限流
    chapterFrom: failure.chapterFrom,
    chapterTo: failure.chapterTo,
    total: targets.length,
    overallTotal: failure.totalChunks || chunkMetas.length,  // v24.0.1：保持原文全局切片总数
  });
  task.text = text;
  task.modelId = opts.modelId;
  task.systemPrompt = opts.systemPrompt;
  task.chunkSize = failure.chunkSize;
  task.chunks = targets.map((t) => t.meta.text);
  // v24.0.1：chunkMetas 局部化为目标子集，与 chunks 同序。executeTask runOne 用
  // task.chunkMetas[task.startIndex + i] 取 meta，chunkIndex 与 failure 全局一致。
  task.chunkMetas = targets.map((t) => t.meta);
  task.startIndex = 0;

  task.promise = new Promise((resolve, reject) => {
    task.resolve = resolve;
    task.reject = reject;
  });

  tasks.set(id, task);
  notifyTask(task);
  scheduleTask(task);
  return task;
}

export function pauseTask(id) {
  const t = tasks.get(id);
  if (!t) return;
  if (t.status === 'running' || t.status === 'idle') {
    updateTask(t, { status: 'paused', isPaused: true });
  }
}

export function resumeTask(id) {
  const t = tasks.get(id);
  if (!t) return;
  if (t.status !== 'paused') return;
  // v24.4.2：原 executeTask 仍在 await runAnalyzesInParallel（worker 池 300ms 轮询）。
  // 只需翻 isPaused=false 让现有 worker 继续 —— 不能 scheduleTask 否则会双 executeTask。
  updateTask(t, { status: 'running', isPaused: false });
}

export function cancelTask(id) {
  const t = tasks.get(id);
  if (!t) return;
  if (!ACTIVE_STATUSES.has(t.status)) return;
  if (t.abortController) t.abortController.abort();
  updateTask(t, { status: 'cancelled', isPaused: false, finishedAt: Date.now() });
  // v24.0.1：修复变量引用（之前是 `task?.resolve` 未声明）
  t.resolve?.({ cancelled: true, successCount: t.successCount, failedCount: t.failedCount });
  pumpQueue();
}

export function removeTask(id) {
  const t = tasks.get(id);
  if (!t) return;
  if (ACTIVE_STATUSES.has(t.status)) {
    cancelTask(id);
  }
  // 从 pendingQueue 移除（如果还在排队）
  const idx = pendingQueue.indexOf(t);
  if (idx >= 0) pendingQueue.splice(idx, 1);
  tasks.delete(id);
  notifyTask(t);  // 通知订阅者「已删除」
}

export function getTask(id) {
  return tasks.get(id) || null;
}

export function getTasksSnapshot() {
  return Array.from(tasks.values()).map((t) => ({
    id: t.id,
    kind: t.kind,
    projectId: t.projectId,
    projectName: t.projectName,
    modelName: t.modelName,
    status: t.status,
    total: t.total,
    overallTotal: t.overallTotal,
    completed: t.completed,
    successCount: t.successCount,
    failedCount: t.failedCount,
    rateLimitCount: t.rateLimitCount,
    degraded: t.degraded,
    initialConcurrency: t.initialConcurrency,
    currentConcurrency: t.currentConcurrency,
    chapterFrom: t.chapterFrom,
    chapterTo: t.chapterTo,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    errorMessage: t.errorMessage,
    failedChunks: t.failedChunks.slice(),
    progress: t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0,
    // v25：true = 刷新后从 progressStore 恢复的展示态记录（需走真实续跑流程才能继续）
    recoverable: Boolean(t._recoverable),
  }));
}

export function subscribe(fn) {
  globalSubscribers.add(fn);
  return () => globalSubscribers.delete(fn);
}

export function subscribeTask(id, fn) {
  const t = tasks.get(id);
  if (!t) return () => {};
  t.onChangeSubscribers.add(fn);
  return () => t.onChangeSubscribers.delete(fn);
}

/**
 * v25：刷新恢复。把 progressStore 里「仍未跑完」的断点变成 interrupted 展示态任务，
 * 让任务面板在刷新后不再丢失已有炼化任务。
 *
 * 恢复项刻意「很轻」：不含 Promise / AbortController / 原文 / 切片 / 任何凭据。
 * 它只是一个入口 —— 用户点「继续」时由 store 走真实的 createContinueTask 流程，
 * 那时才从 progressStore 重新读原文并重新切片。
 *
 * @param {Array} entries 进度记录列表；默认读 progressStore
 * @returns {Array} 本次新建的恢复任务
 */
export function restoreInterruptedTasks(entries = []) {
  const restored = [];
  if (!Array.isArray(entries)) return restored;

  for (const entry of entries) {
    if (!entry || !entry.projectId || entry.active !== true) continue;

    const totalChunks = Number(entry.totalChunks);
    const lastCompleted = Number(entry.lastCompleted);
    // 无效总数不恢复
    if (!Number.isFinite(totalChunks) || totalChunks <= 0) continue;
    // v25：损坏的 lastCompleted（负数 / NaN / Infinity / 非数字 / 缺失）视为记录损坏，
    // 直接忽略而不是回落成 0 —— 回落会凭空造出一条「从头再跑」的假恢复项。
    // lastCompleted >= totalChunks 表示已跑完（正常完成时 progressStore 本就会被清掉）。
    if (!Number.isFinite(lastCompleted) || lastCompleted < 0) continue;
    if (lastCompleted >= totalChunks) continue;
    // 该项目已有任务（含上一次恢复项）时不重复生成
    if (Array.from(tasks.values()).some((t) => t.projectId === entry.projectId)) continue;

    const id = nextTaskId();
    const task = makeTaskRecord({
      id,
      kind: 'continue',
      projectId: entry.projectId,
      projectName: entry.projectName || '',
      modelName: entry.llmModelName || '',
      concurrency: entry.concurrency,
      chapterFrom: entry.chapterFrom || '',
      chapterTo: entry.chapterTo || '',
      total: totalChunks,
      overallTotal: totalChunks,
    });
    task.status = 'interrupted';
    task.completed = lastCompleted;
    task.startIndex = lastCompleted;
    task.createdAt = Number(entry.timestamp) || task.createdAt;
    task._recoverable = true;

    tasks.set(id, task);
    notifyTask(task);
    restored.push(task);
  }

  return restored;
}

/**
 * v25-fix：异步刷新恢复。
 * 之前 v25 在模块加载时同步调 listProgress() —— Node 单测 / SSR 没有浏览器 fetch
 * 时会抛错（listProgress() 现在是 async 且依赖 fetch）。改成显式入口，由 store 在
 * 任务桥订阅完成后调用：拉一次列表，把所有断点恢复成 interrupted 展示态任务。
 *
 * 失败时静默返回：用户没炼化过 / 后端没起来都不应该阻塞 UI 启动。
 */
export async function hydrateInterruptedTasks() {
  let entries;
  try {
    entries = await listProgress();
  } catch (err) {
    console.warn('hydrateInterruptedTasks 拉取断点列表失败', err);
    return [];
  }
  if (!Array.isArray(entries)) return [];
  return restoreInterruptedTasks(entries);
}

// v24.0.1：导出供单测断言
export const __TEST__ = {
  MAX_PARALLEL_TASKS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  pendingQueue,
  tasks,
  hasActiveTaskForProject,
  activeTaskCount,
  pumpQueue,
};
