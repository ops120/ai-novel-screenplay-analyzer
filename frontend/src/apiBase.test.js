import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveApiBase } from './apiBase.js';

test('an explicit API base always wins', () => {
  assert.equal(resolveApiBase({
    envBase: '  https://api.example.test/custom  ',
    protocol: 'file:',
  }), 'https://api.example.test/custom');
});

test('http, https, and file pages all use the same-origin API', () => {
  assert.equal(resolveApiBase({ protocol: 'http:' }), '/api');
  assert.equal(resolveApiBase({ protocol: 'https:' }), '/api');
  assert.equal(resolveApiBase({ protocol: 'file:' }), '/api');
  assert.equal(resolveApiBase(), '/api');
});

