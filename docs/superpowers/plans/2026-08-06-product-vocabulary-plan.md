# 产品文案统一实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有用户可见的旧品牌文案统一为“小说剧本智能分析工作台”，同时保留 storymap 技术标识并迁移旧 Electron 数据目录。

**Architecture:** 只改用户可见的 README、React 文案、HTML 标题、启动提示与 Electron 配置。不改数据库文件名、环境变量、本地存储键、appId 或后端 exe 标识；Electron 启动时增加旧“众生谱” userData 目录作为数据迁移源。

**Tech Stack:** Markdown, React/Vite, Electron, Node.js test runner.

---

### Task 1: Protect legacy Electron data during product rename

**Files:**
- Modify: `electron/databasePersistence.js`
- Modify: `electron/main.js`
- Test: `electron/databasePersistence.test.js`

- [x] **Step 1: Write the failing test** for including an old product userData database candidate while preserving existing candidates.
- [x] **Step 2: Run `npm test --workspace electron` and confirm the new migration expectation fails.**
- [x] **Step 3: Add the old userData candidate to `getLegacyDatabaseCandidates` and pass `app.getPath('appData')/众生谱/storymap.db` from `electron/main.js`.**
- [x] **Step 4: Run the Electron tests and confirm they pass.**

### Task 2: Replace visible product vocabulary

**Files:**
- Modify: `README.md`, `frontend/index.html`, `frontend/src/App.jsx`, `frontend/src/App.css`, `frontend/src/config.js`, `frontend/src/GraphView.jsx`
- Modify: `start.cmd`, `start_backend.cmd`, `start_frontend.cmd`
- Modify: `electron/package.json`, `backend/main.py`, `backend/main.spec`

- [x] **Step 1: Replace visible brand/title strings with `小说剧本智能分析工作台`.**
- [x] **Step 2: Replace visible `研判` phrases with `分析` phrases where they describe the product UI or README.**
- [x] **Step 3: Keep `storymap` technical identifiers unchanged.**

### Task 3: Verify vocabulary and build

**Files:**
- Test: `frontend/src/*.test.js`, `electron/*.test.js`

- [x] **Step 1: Search for old visible brand terms and confirm only intentional technical identifiers remain.**
- [x] **Step 2: Run `npm test` in the frontend and Electron workspaces.**
- [x] **Step 3: Run `npm run build` in `frontend` and inspect the generated app title.**
