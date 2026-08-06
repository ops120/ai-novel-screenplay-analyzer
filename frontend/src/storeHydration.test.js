import test from 'node:test';
import assert from 'node:assert/strict';

test('无页面环境时不自动请求任务断点列表', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalLocalStorage = globalThis.localStorage;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('Node 测试环境不应自动 hydrate');
  };
  delete globalThis.location;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };

  try {
    await import(`./store.js?no-page=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});
