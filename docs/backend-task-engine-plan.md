# 后端任务引擎方案（刷新不中断）

> 状态：待 M3 评估实现 · 2026-08-08
> 目标：分析任务由后端执行，浏览器刷新/关闭页面任务照跑，前端只是重新订阅状态。

## 1. 背景与根因

当前分析任务执行器跑在前端浏览器里（`frontend/src/taskManager.js` 的 `executeTask` + `frontend/src/analysisFlow.js` 的 worker 池）：前端按 chunk 循环调 `POST /api/projects/{pid}/analyze`，把进度断点（`analysis_progress` 表）写后端。**刷新/关页面 = 执行器销毁**，后端只有进度断点，恢复后只能显示「已中断 · 待继续」。进度不丢、可续跑，但「运行中」状态无法跨刷新保持。

## 2. 现状（代码事实）

- 后端单分片分析能力已完整：`POST /api/projects/{pid}/analyze`（main.py:1391）负责——按 `chunk_index × chunk_size` 从 `project_text` 切片、加章节前缀、调 `_analyze_with_llm`（main.py:652，OpenAI 兼容客户端，全局 `asyncio.Semaphore(LLM_CONCURRENCY=3)`，2 次 JSON 校验重试）、把节点/关系写入 `nodes`/`edges` 表。
- 进度断点：`/api/task-progress/{pid}` PUT/PATCH/DELETE（`backend/progress_repository.py` → `analysis_progress` 表：text、chunk_size、concurrency、llm_model_name、chapter_from/to、lastCompleted 单调不回退）。
- 失败索引：`/api/projects/{pid}/failure` PUT/GET/DELETE（`project_failures` 表）。
- chunk 元数据：`GET /api/projects/{pid}/chunk-metas`（章节区间过滤）。
- 前端：`taskManager.js` 拼任务、`executeTask` 调度并发（`analysisFlow.runAnalyzesInParallel`）、`saveProgress`/`saveFailure`；`store.js` 入口 `analyzeText`/`continueAnalysis`/`retryFailedChunks`。

## 3. 方案总览

新增后端任务引擎（单进程 asyncio 注册表）+ 任务 API；前端改为「创建任务 + 轮询状态」，浏览器内执行路径删除。旧端点保留兼容。

## 4. 后端改动

### 4.1 数据模型（新表 `tasks`）

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                 -- analyze | continue | retry
  status TEXT NOT NULL,               -- queued | running | paused | interrupted | completed | failed | cancelled
  chunk_size INTEGER NOT NULL,
  concurrency INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  failed_indexes TEXT NOT NULL DEFAULT '[]',  -- JSON 数组（全局 chunkIndex）
  last_completed INTEGER NOT NULL DEFAULT 0,
  chapter_from TEXT NOT NULL DEFAULT '',
  chapter_to TEXT NOT NULL DEFAULT '',
  llm_model_id TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  rate_limit_count INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
```

### 4.2 任务 API

- `POST /api/projects/{pid}/tasks` —— 创建并启动任务（kind: analyze|continue|retry；chunkSize/concurrency/llmModelId/systemPrompt/chapterFrom/chapterTo）。**同一项目存在 queued/running/paused 任务时返回 409**（解决「同一项目点多了出现多个任务」）。
- `GET /api/projects/{pid}/tasks` —— 任务列表（含实时进度、参数、状态、降级标记）。
- `PATCH /api/projects/{pid}/tasks/{tid}` —— `action: pause | resume | cancel | set_concurrency`。
- `DELETE /api/projects/{pid}/tasks/{tid}` —— 取消并删除记录。
- 保留旧 `/analyze`、`/task-progress`、`/failure`、`/chunk-metas` 端点（兼容旧卡与既有测试）；迁移期旧「待继续」卡点继续 → 走 `POST tasks`（kind=continue，携带 startIndex/失败索引/参数）。

### 4.3 执行器（新模块 `backend/task_engine.py`）

- 全局注册表 `RUNNERS: dict[task_id, RunnerState]`（asyncio.Task + 每任务信号量 + pause Event）。
- 每任务独立 `asyncio.Semaphore(concurrency)`；全局 `SEMAPHORE(LLM_CONCURRENCY)` 仍是总闸。**有效并发 = min(任务并发, 全局闸)**（现状即如此，env `STORYMAP_LLM_CONCURRENCY` 可调，默认不改）。
- worker 循环：取全局 chunk 索引（chunk-metas/章节区间）→ 调共享分析函数（从 analyze 端点抽出 `_run_analyze_and_persist(pid, req)`，HTTP 端点与引擎共用，复用切片+`_analyze_with_llm`+写 nodes/edges 全链路）→ 成功后更新 task 行（completed/last_completed/success_count）；失败写 failed_indexes + failed_count。
- 限流降级：错误分类 429/503（引擎内统一抛带 status_code 的异常），连续 RATE_LIMIT_WINDOW=3 次后该任务有效并发永久降为 1（degraded=true，语义与现前端一致）；新任务才回升。
- 暂停/恢复/取消：pause Event + 取消 in-flight；暂停在切片边界生效；取消保留已写分析结果与断点。
- 后端重启：启动时 `UPDATE tasks SET status='interrupted' WHERE status IN ('queued','running')`；前端显示「待继续」，点继续从 last_completed/failed_indexes 续跑，参数取任务记录。本期不做自动恢复。
- 删除项目：取消该项目 runner；tasks 表 FK ON DELETE CASCADE 清理。

### 4.4 关键实现决策（锁定，不要翻烧饼）

1. 分析函数重构：analyze 端点「切片→_analyze_with_llm→写库」抽成共享函数，HTTP 与引擎共用；错误统一抛带 status_code 的异常（429/503 可识别）。
2. chunk 索引全局化：任务记录用「全局 chunkIndex」（0..total-1，基于 chunk-metas）；continue/retry 都按全局索引。
3. 重试换分片：后端按字符偏移 remap（移植前端 `remapFailureIndexes` 语义：from=floor(i*old/new), to=floor(((i+1)*old-1)/new)，升序去重），在创建 retry 任务时重算索引。
4. 参数归属任务：chunkSize/concurrency/modelId 快照进任务记录（「分析要关联红框参数」由此天然满足）。运行中可 `set_concurrency`；分片只能在创建/重试时改（改分片=按字符偏移 remap 重算索引）。
5. 单项目唯一 active 任务由后端强约束（409），前端同时置灰「运行分析」。
6. 前端进度获取用轮询（有 active 任务时每 2.5s 一次），不做 SSE（稳定后可选项）。

## 5. 前端改动

- 新增 `frontend/src/taskApi.js`（或收敛进 taskManager.js）：`createTask` / `listTasks` / `patchTask(action)` / `deleteTask`。
- `store.js`：`analyzeText`/`continueAnalysis`/`retryFailedChunks` 改为 POST tasks 拿 taskId，不再本地执行；`runAnalyzesInParallel` 不再被调用。
- `TaskPanel.jsx`/App：启动/刷新时 GET tasks 渲染（运行中/排队/暂停/中断/完成/失败）；有 active 任务时轮询；按钮映射 PATCH/DELETE。
- 运行中卡片保留实时进度（completed/total、成功/失败、降级提示）；并发输入框运行中可改（set_concurrency），分片输入框仅创建/重试前可改。
- 删除前端执行路径：`executeTask`/`analysisFlow.js` 不再被 store 调用（文件保留给旧测试或后续清理）；章节切分/remap 逻辑后端接管。

## 6. 测试计划

后端 unittest（临时 DB + mock LLM，不碰真实密钥）：
- tasks CRUD；同项目第二个 active → 409；暂停/恢复/取消状态机；取消后已写分析结果保留；
- 执行器跑 10 片（mock `_analyze_with_llm` 成功）→ completed=10；
- 模拟 3 次 429/503 → degraded=true 且并发收敛到 1（串行证明）；
- 重启模拟（重建引擎，任务标 interrupted）→ resume 后从 last_completed 续跑；
- retry 换 chunkSize → remap 后索引正确。

前端单测：taskApi mock fetch；TaskPanel 渲染/按钮；store 创建任务路径；旧测试同步更新（analysisFlow 测试保留为纯函数测试）。

手工 E2E：启动后端 → UI 建任务 → 刷新浏览器 → 任务继续跑；暂停/继续/取消/删除项目。

## 7. 范围与边界（不要越界）

- 本期不做：SSE、多进程/多机队列、后端重启自动恢复、LLM 供应商改动、DB 路径/端口改动、README 改动。
- 兼容：旧 `/analyze`、`/task-progress`、`/failure`、`/chunk-metas` 保持可用；旧「待继续」卡可经 POST tasks 迁到新引擎。
- 需要用户操作：重启后端（start_backend.cmd）加载新代码；前端 dev server 重启。
- 提交策略：全部改动完成后 commit（不 push），等用户确认后再推送。

## 8. 风险

- SQLite 单写：任务行更新与 HTTP 并发写库走同一连接池 + timeout，执行器写 task 行用短事务。
- 全局并发闸 3：并发>3 时有效并发被压到 3（现状即如此），方案不改默认，env 可调。
- 内存注册表：后端重启任务中断（符合预期，可续跑）；单进程部署下足够。
