import test from 'node:test';
import assert from 'node:assert/strict';

test('file 页面使用本地后端 API，而不是无效的相对 /api', async () => {
  const originalLocation = globalThis.location;
  globalThis.location = { protocol: 'file:' };
  try {
    const { API_BASE } = await import(`./config.js?file-protocol=${Date.now()}`);
    assert.equal(API_BASE, 'http://127.0.0.1:28000/api');
  } finally {
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});
