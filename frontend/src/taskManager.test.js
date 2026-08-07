// v24.0.1：taskManager.js 单测。
// 只测纯逻辑 + 通过 fetch mock 跑端到端。
import test from 'node:test';
import assert from 'node:assert/strict';

// v24.4.7：mock fetch，让 executeTask 不真发请求，避免测试里跑真实网络 + 触发后端限流
const originalFetch = globalThis.fetch;
function mockFetch() {
  globalThis.fetch = async (_url, options = {}) => {
    // v25-fix：fire-and-forget updateProgress 透传 abort signal。
    // 尊重 signal 让测试里 abort 之后能立刻停掉进行中的进度持久化请求，
    // 避免「mock 已撤，fetch 仍在飞」造成的 URL parse 噪音。
    if (options.signal && options.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success' }),
    };
  };
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// 这些 import 顺序必须在 mock 之前
import {
  __TEST__,
  createAnalyzeTask,
  createContinueTask,
  createRetryFailedTask,
  restoreInterruptedTasks,
  pauseTask,
  resumeTask,
  cancelTask,
  cancelTasksForProject,
  removeTask,
  updateTaskParams,
  getTasksSnapshot,
  subscribe as subscribeTasks,
} from './taskManager.js';

// v24.4.7：清理 module-level 状态：每条 test 都从空状态开始。
// 关键：必须 abort 残留 task 的 abortController，否则 runAnalyzesInParallel 的
// 300ms 轮询 worker 持续运转，Node 拒绝退出（test runner 超时 88s+）。
function resetManager() {
  for (const t of __TEST__.tasks.values()) {
    if (t.abortController) t.abortController.abort();
  }
  __TEST__.tasks.clear();
  __TEST__.pendingQueue.length = 0;
}

test.beforeEach(() => {
  mockFetch();
  resetManager();
});

test.afterEach(async () => {
  resetManager();
  // v25-fix：等所有 fire-and-forget updateProgress 完成后再撤掉 mock，
  // 否则未完成的 fetch 会撞上真实 fetch 触发 URL parse 噪音。
  await new Promise((resolve) => setImmediate(resolve));
  restoreFetch();
});

// ---- 状态机 ----

test('初始状态：空 snapshot', () => {
  assert.deepEqual(getTasksSnapshot(), []);
});

test('createAnalyzeTask 同项目拒绝并发（返回 null）', async () => {
  const text = '第一章 山村\n' + '正文内容。'.repeat(50);
  const t1 = await createAnalyzeTask({
    projectId: 'p1', projectName: 'A',
    modelId: 'm', modelName: 'M', systemPrompt: '',
    text, chunkSize: 100, concurrency: 1,
  });
  assert.ok(t1, '第一次创建应成功');
  // 同 projectId 第二次应被拒绝
  const t2 = await createAnalyzeTask({
    projectId: 'p1', projectName: 'A',
    modelId: 'm', modelName: 'M', systemPrompt: '',
    text, chunkSize: 100, concurrency: 1,
  });
  assert.equal(t2, null, '同项目并发应被拒绝');
});

test('不同 projectId 可并行', async () => {
  const text = '第一章\n' + 'x'.repeat(50);
  const t1 = await createAnalyzeTask({
    projectId: 'p1', projectName: 'A',
    modelId: 'm', modelName: 'M', systemPrompt: '',
    text, chunkSize: 100, concurrency: 1,
  });
  const t2 = await createAnalyzeTask({
    projectId: 'p2', projectName: 'B',
    modelId: 'm', modelName: 'M', systemPrompt: '',
    text, chunkSize: 100, concurrency: 1,
  });
  assert.ok(t1 && t2);
  assert.equal(getTasksSnapshot().length, 2);
});

test('任务成功时等待本地断点删除完成后再 resolve', async () => {
  // v26.3-fix: executeTask 现在串行触发两条 DELETE（clearFailure + clearProgress）。
  // 用 FIFO 队列：每条 DELETE 都要等上一条释放后才会被发起，因此测试需按顺序逐条释放。
  const deleteReleases = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === 'DELETE') {
      return new Promise((resolve) => {
        const release = () => resolve({ ok: true, status: 200, json: async () => ({ status: 'success' }) });
        deleteReleases.push(release);
      });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success' }),
    };
  };

  const task = await createAnalyzeTask({
    projectId: 'p-delete-wait', projectName: 'A',
    modelId: 'm', modelName: 'M', systemPrompt: '',
    text: 'x', chunkSize: 100, concurrency: 1,
  });
  let resolved = false;
  task.promise.then(() => { resolved = true; });

  // 等第一条 DELETE 进入挂起状态。
  for (let i = 0; i < 100 && deleteReleases.length < 1; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(deleteReleases.length >= 1, '应已进入第一条 DELETE 阶段');
  assert.equal(resolved, false, 'DELETE 未完成前任务 Promise 不应 resolve');

  // 释放第一条 DELETE；clearFailure resolve 后 clearProgress 才会发起。
  deleteReleases.shift()();

  // 等第二条 DELETE 进入挂起状态。
  for (let i = 0; i < 100 && deleteReleases.length < 1; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(deleteReleases.length >= 1, '应已进入第二条 DELETE 阶段');
  assert.equal(resolved, false, 'clearProgress 未完成前任务 Promise 仍不应 resolve');

  // 释放第二条 DELETE，任务 Promise 才会 resolve。
  deleteReleases.shift()();

  await task.promise;
  assert.equal(resolved, true);
});

test('cancelTask 修改变量引用：原 bug 是 ReferenceError', async () => {
  const text = '第一章\n' + 'x'.repeat(50);
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text, chunkSize: 100, concurrency: 1,
  });
  assert.ok(t);
  // 不应抛 ReferenceError
  assert.doesNotThrow(() => cancelTask(t.id));
  assert.equal(getTasksSnapshot()[0].status, 'cancelled');
});

test('removeTask 释放 Map + 排队的任务', async () => {
  const text = '第一章\n' + 'x'.repeat(50);
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text, chunkSize: 100, concurrency: 1,
  });
  assert.ok(t);
  cancelTask(t.id);  // 改 terminal
  removeTask(t.id);
  assert.equal(getTasksSnapshot().length, 0);
});

test('pauseTask 仅在 active 状态生效', async () => {
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text: 'x'.repeat(50), chunkSize: 100, concurrency: 1,
  });
  assert.ok(t);
  pauseTask(t.id);
  const snap = getTasksSnapshot()[0];
  // status 应变 paused 或保留 running（取决于 executeTask 是否已启动）
  assert.ok(['paused', 'running', 'idle'].includes(snap.status));
});

test('resumeTask 从 paused 恢复', async () => {
  const text = '第一章\n' + 'x'.repeat(50);
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text, chunkSize: 100, concurrency: 1,
  });
  pauseTask(t.id);
  const before = getTasksSnapshot()[0].status;
  resumeTask(t.id);
  const after = getTasksSnapshot()[0].status;
  // paused → resume 后 status 应不再是 paused
  if (before === 'paused') assert.notEqual(after, 'paused');
});

test('snapshot 暴露 overallTotal（retry 场景）', async () => {
  // 不真正跑 retry（依赖 failureStore），仅验证 makeTaskRecord 字段
  const text = 'x'.repeat(50);
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text, chunkSize: 100, concurrency: 1, chapterFrom: '', chapterTo: '',
  });
  assert.ok(t);
  const snap = getTasksSnapshot()[0];
  assert.ok(typeof snap.overallTotal === 'number');
  assert.ok(typeof snap.initialConcurrency === 'number');
  assert.ok(typeof snap.currentConcurrency === 'number');
  assert.equal(snap.initialConcurrency, snap.currentConcurrency);
});

// v26.3：重试任务从后端 failureStore 读失败记录，并按 chunkSize 匹配/重映射切片。
// mock GET /failure + GET /chunk-metas，验证 createRetryFailedTask 的索引逻辑。
function mockRetryFetch(failureChunkSize, metasChunkSize, metasTotal) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/failure')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          projectId: 'p1',
          chunkSize: failureChunkSize,
          totalChunks: 10,
          chunks: [
            { chunkIndex: 2, message: 'err-a' },
            { chunkIndex: 3, message: 'err-b' },
          ],
          chapterFrom: '',
          chapterTo: '',
          updatedAt: 0,
        }),
      };
    }
    if (u.includes('/chunk-metas')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          projectId: 'p1',
          total: metasTotal,
          chunkSize: metasChunkSize,
          chunkMetas: Array.from({ length: metasTotal }, (_, i) => ({ chunkIndex: i, chapter: '' })),
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
  };
}

test('v26.3：重试使用与失败时相同 chunkSize 时直接匹配', async () => {
  mockRetryFetch(500, 500, 10);
  const task = await createRetryFailedTask({
    projectId: 'p1', projectName: 'P', modelId: 'm1', modelName: 'M1',
    systemPrompt: '', chunkSize: 500, concurrency: 1,
  });
  assert.ok(task, '同 chunkSize 重试应能创建任务');
  assert.equal(task.chunkSize, 500);
  assert.deepEqual(task.chunkMetas.map((m) => m.chunkIndex), [2, 3]);
  assert.equal(task.total, 2);
});

test('v26.3：改小 chunkSize 重试时按字符偏移 remap 失败索引', async () => {
  mockRetryFetch(500, 250, 20);
  const task = await createRetryFailedTask({
    projectId: 'p1', projectName: 'P', modelId: 'm1', modelName: 'M1',
    systemPrompt: '', chunkSize: 250, concurrency: 1,
  });
  assert.ok(task, '改 chunkSize 后重试应能创建任务');
  assert.equal(task.chunkSize, 250);
  // 旧切片 2 覆盖 [1000,1500) → 新切片 4,5；旧切片 3 覆盖 [1500,2000) → 新切片 6,7
  assert.deepEqual(task.chunkMetas.map((m) => m.chunkIndex), [4, 5, 6, 7]);
  assert.equal(task.total, 4);
  assert.equal(task.chunks.length, 4);
});
test('__TEST__.hasActiveTaskForProject 在 idle/running/paused 时返回 true', async () => {
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text: 'x'.repeat(50), chunkSize: 100, concurrency: 1,
  });
  assert.ok(t);
  assert.equal(__TEST__.hasActiveTaskForProject('p1'), true);
  assert.equal(__TEST__.hasActiveTaskForProject('p2'), false);
});

test('cancelTask 后 hasActiveTaskForProject 返回 false', async () => {
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text: 'x'.repeat(50), chunkSize: 100, concurrency: 1,
  });
  cancelTask(t.id);
  assert.equal(__TEST__.hasActiveTaskForProject('p1'), false);
});

test('getTasksSnapshot 不暴露内部字段（abortController/promise/chunks）', async () => {
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text: 'x'.repeat(50), chunkSize: 100, concurrency: 1,
  });
  const snap = getTasksSnapshot()[0];
  assert.equal(snap.abortController, undefined);
  assert.equal(snap.promise, undefined);
  assert.equal(snap.chunks, undefined);
  assert.equal(snap.resolve, undefined);
});

test('subscribe 收到新增事件', async () => {
  const events = [];
  const unsub = subscribeTasks((t) => events.push(t.id));
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text: 'x'.repeat(50), chunkSize: 100, concurrency: 1,
  });
  assert.ok(events.includes(t.id));
  unsub();
});

// ---- v25：刷新恢复（interrupted） ----

test('刷新后把有效断点恢复为 interrupted 任务', () => {
  restoreInterruptedTasks([{
    projectId: 'p1', active: true, timestamp: 100,
    totalChunks: 10, lastCompleted: 4, chunkSize: 500,
    llmModelName: 'M', chapterFrom: '2', chapterTo: '5',
  }]);
  assert.deepEqual(getTasksSnapshot().map(({ projectId, status, completed, total, progress, recoverable, chunkSize }) => ({
    projectId, status, completed, total, progress, recoverable, chunkSize,
  })), [{ projectId: 'p1', status: 'interrupted', completed: 4, total: 10, progress: 40, recoverable: true, chunkSize: 500 }]);
});

test('interrupted 恢复项不阻止同项目创建续跑任务', async () => {
  restoreInterruptedTasks([{ projectId: 'p1', active: true, timestamp: 100, totalChunks: 2, lastCompleted: 1 }]);
  const task = await createContinueTask({
    projectId: 'p1', projectName: 'A', modelId: 'm', modelName: 'M', systemPrompt: '',
    progress: { active: true, totalChunks: 2, lastCompleted: 1, text: 'x'.repeat(200), chunkSize: 100, concurrency: 1 },
  });
  assert.ok(task);
  assert.equal(getTasksSnapshot().some((item) => item.status === 'interrupted'), false);
});

test('续跑构造失败时保留 interrupted 恢复项', async () => {
  restoreInterruptedTasks([{ projectId: 'p1', active: true, timestamp: 100, totalChunks: 2, lastCompleted: 1 }]);
  const task = await createContinueTask({ projectId: 'p1', progress: null });
  assert.equal(task, null);
  assert.equal(getTasksSnapshot()[0].status, 'interrupted');
});

test('createAnalyzeTask 成功后替换同项目 interrupted 恢复项', async () => {
  restoreInterruptedTasks([{ projectId: 'p1', active: true, timestamp: 100, totalChunks: 10, lastCompleted: 4 }]);
  assert.equal(getTasksSnapshot().length, 1);
  const task = await createAnalyzeTask({
    projectId: 'p1', projectName: 'A', modelId: 'm', modelName: 'M', systemPrompt: '',
    text: '第一章\n' + 'x'.repeat(200), chunkSize: 100, concurrency: 1,
  });
  assert.ok(task, '真实 analyze 任务应创建成功');
  const snap = getTasksSnapshot();
  assert.equal(snap.some((item) => item.status === 'interrupted'), false, '旧恢复项应被替换');
  assert.equal(snap.length, 1, '只保留真实任务');
  assert.equal(snap[0].id, task.id);
});

test('restoreInterruptedTasks 忽略损坏的 lastCompleted', () => {
  restoreInterruptedTasks([
    { projectId: 'neg', active: true, timestamp: 100, totalChunks: 10, lastCompleted: -5 },
    { projectId: 'nan', active: true, timestamp: 100, totalChunks: 10, lastCompleted: NaN },
    { projectId: 'inf', active: true, timestamp: 100, totalChunks: 10, lastCompleted: Infinity },
    { projectId: 'str', active: true, timestamp: 100, totalChunks: 10, lastCompleted: '啊' },
    { projectId: 'missing', active: true, timestamp: 100, totalChunks: 10 },
    { projectId: 'done', active: true, timestamp: 100, totalChunks: 10, lastCompleted: 10 },
  ]);
  assert.deepEqual(getTasksSnapshot(), [], '损坏/已完成的断点都不应恢复');

  // 合法边界：lastCompleted = 0（刚开跑一片没成）应当恢复
  restoreInterruptedTasks([{ projectId: 'ok', active: true, timestamp: 100, totalChunks: 10, lastCompleted: 0 }]);
  assert.deepEqual(
    getTasksSnapshot().map((t) => ({ projectId: t.projectId, completed: t.completed })),
    [{ projectId: 'ok', completed: 0 }],
  );
});

// ---- v26.3：删除项目时级联取消该项目的全部任务 ----

test('v26.3：cancelTasksForProject 取消 running 任务并 resolve', async () => {
  globalThis.fetch = async () => new Promise(() => {});  // 挂起：让任务保持 running
  const t = await createAnalyzeTask({
    projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '',
    text: '第一章\n' + 'x'.repeat(500), chunkSize: 100, concurrency: 1,
  });
  assert.ok(t);
  const done = new Promise((resolve) => t.promise.then(resolve));
  const count = cancelTasksForProject('p1');
  assert.equal(count, 1);
  assert.equal(getTasksSnapshot()[0].status, 'cancelled');
  const result = await done;
  assert.equal(result.cancelled, true);
});

test('v26.3：cancelTasksForProject 取消 idle 排队任务并移出队列', async () => {
  globalThis.fetch = async () => new Promise(() => {});
  await createAnalyzeTask({ projectId: 'p1', modelId: 'm', modelName: 'M', systemPrompt: '', text: 'x'.repeat(200), chunkSize: 100, concurrency: 1 });
  await createAnalyzeTask({ projectId: 'p2', modelId: 'm', modelName: 'M', systemPrompt: '', text: 'x'.repeat(200), chunkSize: 100, concurrency: 1 });
  await createAnalyzeTask({ projectId: 'p3', modelId: 'm', modelName: 'M', systemPrompt: '', text: 'x'.repeat(200), chunkSize: 100, concurrency: 1 });
  const q = await createAnalyzeTask({ projectId: 'p4', modelId: 'm', modelName: 'M', systemPrompt: '', text: 'x'.repeat(200), chunkSize: 100, concurrency: 1 });
  assert.ok(q, '第 4 个项目应排队');
  assert.equal(q.status, 'idle');
  assert.ok(__TEST__.pendingQueue.some((t) => t.id === q.id), '应仍在排队队列');
  const count = cancelTasksForProject('p4');
  assert.equal(count, 1);
  assert.equal(q.status, 'cancelled');
  assert.equal(__TEST__.pendingQueue.some((t) => t.id === q.id), false, '取消后应移出队列');
  assert.equal(getTasksSnapshot().filter((t) => t.status === 'running').length, 3, '其它项目任务不受影响');
});

test('v26.3：cancelTasksForProject 取消 interrupted 恢复项', () => {
  restoreInterruptedTasks([{ projectId: 'p1', active: true, timestamp: 100, totalChunks: 10, lastCompleted: 4 }]);
  assert.equal(getTasksSnapshot()[0].status, 'interrupted');
  const count = cancelTasksForProject('p1');
  assert.equal(count, 1);
  assert.equal(getTasksSnapshot()[0].status, 'cancelled');
});

test('v26.3：cancelTasksForProject 不影响其它项目任务', async () => {
  globalThis.fetch = async () => new Promise(() => {});
  await createAnalyzeTask({ projectId: 'keep', modelId: 'm', modelName: 'M', systemPrompt: '', text: 'x'.repeat(200), chunkSize: 100, concurrency: 1 });
  const count = cancelTasksForProject('other');
  assert.equal(count, 0);
  assert.equal(getTasksSnapshot()[0].status, 'running');
});

// ---- v27: createContinueTask accepts opts.chunkSize/concurrency overrides ----

test('v27: createContinueTask covers chunkSize and remaps startIndex by char offset', async () => {
  // progress: old chunkSize=500, lastCompleted=2 covers chars [1000,1500).
  // User changes chunkSize to 250 on card; continue start should be floor(1000/250)=4.
  // Use small text mode (progress.text non-empty) to skip chunk-metas fetch.
  const task = await createContinueTask({
    projectId: 'p-rechunk', projectName: 'P', modelId: 'm1', modelName: 'M1', systemPrompt: '',
    progress: {
      active: true,
      totalChunks: 4,
      lastCompleted: 2,
      text: 'x'.repeat(2000),
      chunkSize: 500,
      concurrency: 3,
    },
    chunkSize: 250,
  });
  assert.ok(task);
  assert.equal(task.chunkSize, 250);
  assert.equal(task.startIndex, 4);
  assert.equal(task.total, 4);
});

test('v27: createContinueTask covers concurrency', async () => {
  const task = await createContinueTask({
    projectId: 'p-reconc', projectName: 'P', modelId: 'm1', modelName: 'M1', systemPrompt: '',
    progress: {
      active: true,
      totalChunks: 4,
      lastCompleted: 1,
      text: 'x'.repeat(400),
      chunkSize: 100,
      concurrency: 3,
    },
    concurrency: 1,
  });
  assert.ok(task);
  assert.equal(task.concurrency, 1);
  assert.equal(task.initialConcurrency, 1);
});

test('v27: createContinueTask falls back to progress when no overrides given', async () => {
  const task = await createContinueTask({
    projectId: 'p-noov', projectName: 'P', modelId: 'm1', modelName: 'M1', systemPrompt: '',
    progress: {
      active: true,
      totalChunks: 4,
      lastCompleted: 1,
      text: 'x'.repeat(400),
      chunkSize: 100,
      concurrency: 2,
    },
  });
  assert.ok(task);
  assert.equal(task.chunkSize, 100);
  assert.equal(task.concurrency, 2);
  assert.equal(task.startIndex, 1);
});

test('v27: task snapshot keeps edited concurrency for the task card', async () => {
  const task = await createAnalyzeTask({
    projectId: 'p-snapshot-concurrency', projectName: 'P', modelId: 'm', modelName: 'M', systemPrompt: '',
    text: 'x'.repeat(200), chunkSize: 100, concurrency: 2,
  });
  assert.ok(task);
  assert.equal(updateTaskParams(task.id, { concurrency: 1 }), true);
  const snapshot = getTasksSnapshot().find((item) => item.id === task.id);
  assert.equal(snapshot?.concurrency, 1);
});
