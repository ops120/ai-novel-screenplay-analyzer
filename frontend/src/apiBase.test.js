import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveApiBase } from './apiBase.js';

test('an explicit API base always wins', () => {
  assert.equal(resolveApiBase({
    envBase: 'https://api.example.test/custom',
    protocol: 'http:',
  }), 'https://api.example.test/custom');
});

test('Electron file pages connect directly to the local backend', () => {
  assert.equal(
    resolveApiBase({ protocol: 'file:' }),
    'http://127.0.0.1:28000/api',
  );
});

test('web development pages use the same-origin Vite proxy', () => {
  assert.equal(resolveApiBase({ protocol: 'http:' }), '/api');
  assert.equal(resolveApiBase({ protocol: 'https:' }), '/api');
});

