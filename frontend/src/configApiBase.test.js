import test from 'node:test';
import assert from 'node:assert/strict';

test('configured API base honors an explicit environment override', async () => {
  const { resolveConfiguredApiBase } = await import('./config.js');

  assert.equal(typeof resolveConfiguredApiBase, 'function');
  assert.equal(
    resolveConfiguredApiBase({
      VITE_API_BASE: ' https://api.example.test/custom ',
    }),
    'https://api.example.test/custom',
  );
  assert.equal(resolveConfiguredApiBase({}), '/api');
});
