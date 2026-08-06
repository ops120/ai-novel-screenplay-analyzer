import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const timeline = fs.readFileSync(new URL('./RelationshipTimeline.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./App.css', import.meta.url), 'utf8');

test('timeline drawer delegates a single workspace to RelationshipTimeline', () => {
  const drawer = app.slice(
    app.indexOf('{/* ---- 关系演化 左侧抽屉 ---- */}'),
    app.indexOf('{/* ---- 弹层：任务'),
  );
  assert.match(drawer, /<RelationshipTimeline/);
  assert.doesNotMatch(drawer, /className="nl-tl-h"/);
  assert.match(drawer, /projectName=/);
  assert.match(drawer, /updatedAt=/);
});

test('timeline workspace reuses panorama header and toolbar with one fullscreen owner', () => {
  assert.match(timeline, /nl-main-h nl-timeline-workspace-head/);
  assert.match(timeline, /nl-toolbar nl-timeline-workspace-toolbar/);
  assert.match(timeline, /requestFullscreen\(\)/);
  assert.match(timeline, /document\.exitFullscreen\(\)/);
  assert.match(timeline, /collapsed/);
});

test('timeline drawer and fullscreen workspace have bounded layout styles', () => {
  assert.match(css, /\.nl-left-drawer-timeline\s*\{[\s\S]*?width:\s*min\(920px,\s*92vw\)/);
  assert.match(css, /\.nl-timeline-workspace:fullscreen\s*\{/);
});
