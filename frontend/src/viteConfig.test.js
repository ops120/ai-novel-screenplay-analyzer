import test from 'node:test';
import assert from 'node:assert/strict';

import createViteConfig from '../vite.config.js';

test('the development server proxies same-origin API requests to the backend', () => {
  const config = createViteConfig({ mode: 'test' });

  assert.equal(config.server.proxy['/api'].target, 'http://127.0.0.1:28000');
});

test('the development server uses the conflict-avoiding frontend port', () => {
  const config = createViteConfig({ mode: 'test' });

  assert.equal(config.server.port, 15173);
});
