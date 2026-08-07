import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('./App.css', import.meta.url), 'utf8');

test('the visible import-text control is a directly clickable native file input', () => {
  const control = appSource.match(
    /<label\s+className="secondary-button text-file-import-control"[^>]*>[\s\S]*?<\/label>/,
  );

  assert.ok(control, 'missing the native import-text control');
  assert.match(control[0], /<input[\s\S]*?type="file"[\s\S]*?className="text-file-input-native"/);
  assert.doesNotMatch(control[0], /onClick=/);

  const inputRule = appCss.match(/\.text-file-input-native\s*\{([^}]*)\}/);
  assert.ok(inputRule, 'missing the native input overlay rule');
  assert.match(inputRule[1], /position:\s*absolute/);
  assert.match(inputRule[1], /inset:\s*0/);
  assert.match(inputRule[1], /opacity:\s*0/);
  assert.match(inputRule[1], /cursor:\s*pointer/);
  assert.doesNotMatch(inputRule[1], /pointer-events:\s*none|z-index:\s*-\d/);
});
