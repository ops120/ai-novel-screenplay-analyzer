import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appCss = readFileSync(new URL('./App.css', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const css = `${indexCss}\n${appCss}`;

test('defines the editorial palette with a system sans UI', () => {
  for (const token of ['#f4f0e7', '#faf8f2', '#ece6da', '#292721', '#746f65', '#d5cec0', '#9a4936']) {
    assert.match(css.toLowerCase(), new RegExp(token));
  }
  assert.match(indexCss, /font-family:\s*system-ui/);
  assert.doesNotMatch(css, /\bInter\b|#667eea/i);
});

test('lays out all four narrative workspace slots', () => {
  assert.match(appCss, /\.narrative-workspace\s*\{/);
  assert.match(appCss, /grid-template-areas:\s*[\s\S]*['"]sidebar graph inspector['"][\s\S]*['"]sidebar timeline timeline['"]/);
  for (const slot of ['sidebar', 'graph', 'inspector', 'timeline']) {
    assert.match(appCss, new RegExp(`\\.workspace-${slot}\\s*\\{[\\s\\S]*?grid-area:\\s*${slot}`));
  }
});

test('visually distinguishes graph loading empty error and rendering states', () => {
  for (const selector of ['graph-state-loading', 'graph-state-empty', 'graph-state-error', 'graph-rendering-overlay', 'graph-canvas']) {
    assert.match(appCss, new RegExp(`\\.${selector}\\s*\\{`));
  }
});

test('has compact responsive workspace contracts and reduced motion', () => {
  assert.match(appCss, /@media\s*\(max-width:\s*1100px\)/);
  assert.match(appCss, /@media\s*\(max-width:\s*820px\)[\s\S]*grid-template-areas:\s*[\s\S]*['"]graph['"][\s\S]*['"]sidebar['"][\s\S]*['"]inspector['"][\s\S]*['"]timeline['"]/);
  assert.match(appCss, /@media\s*\(max-width:\s*560px\)[\s\S]*\.relationship-tracks[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(appCss, /grid-template-rows:\s*340px\s+620px\s+620px/);
});

test('bounds the desktop graph sizing chain to prevent ResizeObserver growth loops', () => {
  assert.match(appCss, /\.narrative-workspace\s*\{[\s\S]*?height:\s*max\(780px,\s*calc\(100dvh\s*-\s*100px\)\)/);
  assert.match(appCss, /\.narrative-workspace\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)\s+minmax\(180px,\s*240px\)/);
  assert.match(appCss, /\.workspace-graph\s+\.graph-view\s*,\s*\.workspace-graph\s+\.graph-canvas\s*\{[\s\S]*?min-height:\s*0[\s\S]*?overflow:\s*hidden/);
  assert.match(appCss, /@media\s*\(max-width:\s*820px\)[\s\S]*?\.narrative-workspace\s*\{[\s\S]*?height:\s*auto/);
  assert.match(appCss, /@media\s*\(max-width:\s*820px\)[\s\S]*?\.workspace-graph\s*\{[\s\S]*?height:\s*clamp\(/);
});
