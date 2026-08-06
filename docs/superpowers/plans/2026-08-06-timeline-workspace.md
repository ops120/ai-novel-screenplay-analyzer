# Timeline Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将关系演化时间线统一为与 IP 关系全景相同的标题栏、工具栏、内容区视觉结构，并让折叠与全屏作用于整个时间线工作区。

**Architecture:** 由 `RelationshipTimeline` 单独拥有工作区标题、工具栏、内容、折叠和 Fullscreen API 状态；`App` 只负责抽屉开关、数据和回调传递，删除外层重复时间线结构。CSS 复用现有 `nl-main-h`、`nl-toolbar`、`nl-pill` 基础类，仅为时间线抽屉宽度、全屏容器和滚动区增加限定样式。

**Tech Stack:** React 19、原生 Fullscreen API、CSS、Node.js test runner、Vite

---

### Task 1: 锁定统一工作区结构契约

**Files:**
- Create: `frontend/src/timelineWorkspace.test.js`
- Test: `frontend/src/timelineWorkspace.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const timeline = fs.readFileSync(new URL('./RelationshipTimeline.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./App.css', import.meta.url), 'utf8');

test('timeline drawer delegates a single workspace to RelationshipTimeline', () => {
  const drawer = app.slice(app.indexOf('{/* ---- 关系演化 左侧抽屉 ---- */'), app.indexOf('{/* ---- 弹层：任务'));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --test src/timelineWorkspace.test.js`

Expected: FAIL because the drawer still owns `nl-tl-h`, and the component/CSS do not yet expose the unified workspace classes.

- [ ] **Step 3: Commit the failing test**

```bash
git add frontend/src/timelineWorkspace.test.js
git commit -m "test: define timeline workspace visual contract"
```

### Task 2: Make RelationshipTimeline the single workspace owner

**Files:**
- Modify: `frontend/src/RelationshipTimeline.jsx`
- Modify: `frontend/src/App.jsx:155,1185-1252`
- Test: `frontend/src/timelineWorkspace.test.js`

- [ ] **Step 1: Extend the component inputs and heading context**

Add `projectName = ''` and `updatedAt = '—'` to `RelationshipTimeline` props. Derive the heading and metadata without changing track filtering:

```jsx
const workspaceTitle = projectName ? `关系演化时间线 · ${projectName}` : '关系演化时间线';
const workspaceSubtitle = hasChapters
  ? `按已识别章节追踪关系变化 · ${tracks.length} 条关系轨迹`
  : `未识别章节标记 · ${tracks.length} 条关系轨迹`;
```

- [ ] **Step 2: Replace the component shell with panorama structure**

Keep the existing `timelineRef`, `collapsed`, `fullscreen`, `toggleFullscreen`, filter controls and track list. Replace the top-level rendering structure with:

```jsx
<section
  ref={timelineRef}
  className={`nl-timeline nl-timeline-workspace${collapsed ? ' collapsed' : ''}${fullscreen ? ' fullscreen' : ''}`}
  aria-labelledby="timeline-heading"
>
  <header className="nl-main-h nl-timeline-workspace-head">
    <div className="nl-main-h-left">
      <h2 id="timeline-heading">{workspaceTitle}</h2>
      <div className="nl-main-subline">{workspaceSubtitle}</div>
    </div>
    <div className="nl-timeline-workspace-actions">
      <span className="nl-tl-ts">最近更新 {updatedAt || '—'}</span>
      <button type="button" className="nl-pill" onClick={toggleFullscreen}>
        {fullscreen ? '退出全屏' : '全屏'}
      </button>
      <button type="button" className="nl-pill" onClick={() => setCollapsed(v => !v)} aria-expanded={!collapsed}>
        {collapsed ? '展开' : '折叠'}
      </button>
    </div>
  </header>
  {!collapsed && (
    <>
      <div className="nl-toolbar nl-timeline-workspace-toolbar">{/* existing filter controls */}</div>
      <div className="nl-timeline-body">{/* existing filter chip, empty state, and tracks */}</div>
    </>
  )}
</section>
```

- [ ] **Step 3: Remove the duplicate App-owned timeline section**

Delete the `timelineCollapsed` state from `App`. Inside `.nl-left-drawer-body`, render exactly one `RelationshipTimeline` for both empty and populated data:

```jsx
<RelationshipTimeline
  tracks={timelineTracks}
  viewMode={s.viewMode}
  onViewModeChange={s.setViewMode}
  chapterFilter={null}
  chapterOptions={graphChapterOptions}
  onChapterChange={() => {}}
  onSelectNode={s.setSelectedNodeId}
  selectedNodeLabel={selectedProfile?.label || ''}
  projectName={currentProject?.name || ''}
  updatedAt={s.lastUpdateAt || '—'}
/>
```

- [ ] **Step 4: Run the structure contract test**

Run: `cd frontend && node --test src/timelineWorkspace.test.js`

Expected: the JSX structure tests pass; the CSS width/fullscreen test still fails until Task 3.

### Task 3: Align drawer, fullscreen, scrolling, and responsive styles

**Files:**
- Modify: `frontend/src/App.css:812-861,1058-1067,1637-1770`
- Test: `frontend/src/timelineWorkspace.test.js`

- [ ] **Step 1: Add the timeline workspace layout rules**

Append scoped rules that reuse the panorama surface without affecting the main graph:

```css
.nl-left-drawer-timeline {
  width: min(920px, 92vw);
}

.nl-left-drawer-timeline .nl-left-drawer-body {
  padding: 0;
  overflow: hidden;
}

.nl-timeline-workspace {
  min-height: 0;
  height: 100%;
  background: var(--surface);
}

.nl-timeline-workspace-head {
  align-items: flex-end;
}

.nl-timeline-workspace-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.nl-timeline-workspace-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nl-timeline-workspace-toolbar {
  flex-shrink: 0;
}

.nl-timeline-workspace:fullscreen {
  width: 100vw;
  height: 100vh;
  background: var(--surface);
}

.nl-timeline-workspace.collapsed {
  flex: 0 0 auto;
}
```

- [ ] **Step 2: Preserve compact behavior on narrow screens**

Add a narrow-screen rule:

```css
@media (max-width: 720px) {
  .nl-left-drawer-timeline { width: 100vw; max-width: 100vw; }
  .nl-timeline-workspace-head { align-items: flex-start; }
  .nl-timeline-workspace-actions { width: 100%; flex-wrap: wrap; }
  .nl-timeline-workspace-toolbar { padding-inline: 12px; }
}
```

- [ ] **Step 3: Run the new test and the narrative regression suite**

Run:

```bash
cd frontend
node --test src/timelineWorkspace.test.js src/narrativeModel.test.js
```

Expected: 35 tests pass, 0 fail.

- [ ] **Step 4: Build the frontend**

Run: `cd frontend && npm run build`

Expected: Vite exits 0. Existing bundle-size warnings are acceptable; no syntax or CSS build errors.

- [ ] **Step 5: Commit the implementation**

```bash
git add frontend/src/App.jsx frontend/src/App.css frontend/src/RelationshipTimeline.jsx frontend/src/timelineWorkspace.test.js
git commit -m "feat: align relationship timeline with panorama workspace"
```

### Task 4: Runtime smoke test

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Confirm the dev server responds**

Run: `Invoke-WebRequest http://127.0.0.1:15173 -UseBasicParsing`

Expected: HTTP 200.

- [ ] **Step 2: Verify behavior in the browser**

Open the relationship timeline drawer and confirm:

1. One title bar, one toolbar, and one content region are visible.
2. Fold hides only the toolbar/body and keeps the title bar visible.
3. Fullscreen expands the entire timeline workspace; Esc exits cleanly.
4. Existing occurrence filters and person selection still respond.

- [ ] **Step 3: Record final repository status**

Run: `git status --short && git log -3 --oneline`

Expected: working tree is clean and the implementation commit is at `HEAD`.
