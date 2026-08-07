import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appCss = readFileSync(new URL('./App.css', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const css = `${indexCss}\n${appCss}`;

test('defines the editorial palette with a system sans UI', () => {
  for (const token of ['#f5f3ee', '#ffffff', '#fafaf7', '#1a1a1a', '#5a5a5a', '#8e8e8e', '#e6e4dd', '#b8323a', '#a87939', '#f7e8e9']) {
    assert.match(css.toLowerCase(), new RegExp(token));
  }
  assert.match(indexCss, /system-ui/);
  assert.doesNotMatch(css, /\bInter\b|#667eea/i);
});

test('lays out the four main workspace zones on the app grid', () => {
  assert.match(appCss, /\.nl-app\s*\{[\s\S]*?grid-template-columns:\s*60px\s+1fr\s+320px/);
  assert.match(appCss, /\.nl-app\s*\{[\s\S]*?grid-template-rows:\s*54px\s+1fr/);
  for (const [selector, placement] of [
    ['.nl-topbar', 'grid-column: 1 / -1'],
    ['.nl-rail', 'grid-column: 1'],
    ['.nl-main', 'grid-column: 2'],
    ['.nl-inspector', 'grid-column: 3'],
  ]) {
    assert.match(appCss, new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[\\s\\S]*?${placement}`));
  }
});

test('visually distinguishes empty, placeholder, and rendered graph canvas states', () => {
  for (const selector of ['nl-graph-wrap', 'nl-graph-empty', 'nl-graph-empty-card', 'nl-graph-placeholder', 'nl-graph-canvas-bg', 'nl-graph-canvas-grid', 'nl-corner']) {
    assert.match(appCss, new RegExp(`\\.${selector}\\s*\\{`));
  }
});

test('has compact responsive workspace contracts and reduced motion', () => {
  assert.match(appCss, /@media\s*\(max-width:\s*720px\)/);
  assert.match(appCss, /@media\s*\(max-width:\s*520px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(appCss, /grid-template-rows:\s*340px\s+620px\s+620px/);
});

test('bounds the desktop graph sizing chain to prevent ResizeObserver growth loops', () => {
  assert.match(appCss, /\.nl-main\s*\{[\s\S]*?display:\s*flex[\s\S]*?overflow:\s*hidden/);
  assert.match(appCss, /\.nl-graph-wrap\s*\{[\s\S]*?flex:\s*1[\s\S]*?overflow:\s*hidden/);
  assert.match(appCss, /\.nl-inspector\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(appCss, /\.focus-mode\s+\.nl-graph-wrap\s*\{[\s\S]*?position:\s*fixed/);
});
