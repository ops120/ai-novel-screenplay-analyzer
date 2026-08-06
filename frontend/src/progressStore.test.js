import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  saveProgress,
  getProgress,
  listProgress,
  updateProgress,
  clearProgress,
} from './progressStore.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalLocalStorage;
});

test('大文本断点通过本地后端持久化，不依赖浏览器 localStorage 配额', async () => {
  const calls = [];
  globalThis.localStorage = {
    getItem() { throw new Error('不应读取 localStorage'); },
    setItem() { throw new Error('不应写入 localStorage'); },
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const text = '修'.repeat(5_100_000);
  await saveProgress('project-999', {
    totalChunks: 10_200,
    lastCompleted: 3,
    text,
    chunkSize: 500,
    concurrency: 3,
    llmModelName: 'M',
    chapterFrom: '',
    chapterTo: '',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/task-progress/project-999');
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(JSON.parse(calls[0].options.body).text.length, text.length);
});

test('读取、列举、更新和清除断点都走本地后端 API', async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/task-progress/project-999' && !options.method) {
      return { ok: true, json: async () => ({ projectId: 'project-999', text: '正文', active: true }) };
    }
    if (url === '/api/task-progress') {
      return { ok: true, json: async () => ([{ projectId: 'project-999', active: true }]) };
    }
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  assert.equal((await getProgress('project-999')).text, '正文');
  assert.equal((await listProgress()).length, 1);
  await updateProgress('project-999', { lastCompleted: 4 });
  await clearProgress('project-999');

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method || 'GET']), [
    ['/api/task-progress/project-999', 'GET'],
    ['/api/task-progress', 'GET'],
    ['/api/task-progress/project-999', 'PATCH'],
    ['/api/task-progress/project-999', 'DELETE'],
  ]);
});
