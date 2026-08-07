import { create } from 'zustand';
import { API_BASE, loadConfig, saveConfig } from './config.js';
import * as taskManager from './taskManager.js';
import { listTasks as apiListTasks, createTask as apiCreateTask, patchTask as apiPatchTask, deleteTask as apiDeleteTask, rowToTask as apiRowToTask } from './taskApi.js';
import { getFailure, clearFailure } from './failureStore.js';
import { listProgress, clearProgress } from './progressStore.js';
import { readSelectedLlmId, writeSelectedLlmId, clearLegacyLlmConfig, resolveSelectedLlmId } from './llmSelection.js';

// 加载配置
const config = loadConfig();

// v24.4.6：清除旧版llm_config（迁移到 llmSelection.js）
clearLegacyLlmConfig(localStorage);

// 安装 task bridge（只一次）
let _bridgeInstalled = false;
function installTaskBridge(set, get) {
  if (_bridgeInstalled) return;
  _bridgeInstalled = true;
  // v28: 后端任务引擎。store.tasks 维持最近一次轮询的结果；
  // 异步轮询由 startBackendTaskPolling() 启动。
  set({ tasks: [] });
  // 异步轮询由 App.jsx mount 时调用 startBackendTaskPolling(); 测试不启动
}

// v28: 后端任务轮询
// 有 active 任务时 2.5s 一次，其他情况 5s 一次。
let _pollingTimer = null;
let _pollingInterval = 5000;
function startBackendTaskPolling(set, get) {
  if (_pollingTimer) return;
  const tick = async () => {
    try {
      const tasks = await fetchAllTasks(get);
      set({ tasks });
      // 调整轮询频率：有 active 任务时 2.5s 一次，其他情况 5s 一次。
      const hasActive = tasks.some(t => ['running', 'paused', 'queued'].includes(t.status));
      const newInterval = hasActive ? 2500 : 5000;
      if (newInterval !== _pollingInterval) {
        _pollingInterval = newInterval;
        if (_pollingTimer) { clearInterval(_pollingTimer); _pollingTimer = null; }
        _pollingTimer = setInterval(tick, _pollingInterval);
      }
    } catch (e) {
      // 忽略轮询错误（后端可能重启中）
    }
  };
  _pollingInterval = 5000;
  tick();
  _pollingTimer = setInterval(tick, _pollingInterval);
}

function stopBackendTaskPolling() {
  if (_pollingTimer) {
    clearInterval(_pollingTimer);
    _pollingTimer = null;
  }
}

// v28-fix: 全局任务拉取（不依赖选中项目）
// - 拉取所有项目的后端任务（projects + currentProjectId + 旧断点涉及的 pid）
// - 把旧版浏览器执行残留的 analysis_progress 断点恢复为「已中断 · 待继续」卡片；
//   项目已有后端任务行时跳过（避免重复），已完成（lastCompleted>=total）自动消失。
function legacyRowToTask(p) {
  const pid = p.projectId || p.project_id;
  const total = Number(p.totalChunks ?? p.total_chunks ?? 0);
  const lastCompleted = Number(p.lastCompleted ?? p.last_completed ?? 0);
  const chunkSize = Number(p.chunkSize ?? p.chunk_size ?? 0);
  const concurrency = Number(p.concurrency || 3);
  return {
    id: `legacy:${pid}`,
    kind: 'continue',
    projectId: pid,
    projectName: '',
    modelName: p.llmModelName || p.llm_model_name || '',
    status: 'interrupted',
    total,
    overallTotal: total,
    completed: lastCompleted,
    lastCompleted,
    successCount: lastCompleted,
    failedCount: 0,
    rateLimitCount: 0,
    degraded: false,
    initialConcurrency: concurrency,
    currentConcurrency: concurrency,
    concurrency,
    chapterFrom: p.chapterFrom || p.chapter_from || '',
    chapterTo: p.chapterTo || p.chapter_to || '',
    chunkSize,
    createdAt: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
    startedAt: 0,
    finishedAt: 0,
    updatedAt: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
    errorMessage: '',
    failedChunks: [],
    chunks: [],
    chunkMetas: [],
    startIndex: lastCompleted,
    progress: total > 0 ? Math.min(100, Math.round((lastCompleted / total) * 100)) : 0,
    isPaused: false,
    llmModelId: '',
    systemPrompt: '',
  };
}
async function fetchAllTasks(get) {
  const s = get();
  const pids = new Set();
  if (s.currentProjectId) pids.add(s.currentProjectId);
  for (const p of s.projects || []) {
    if (p && p.id) pids.add(p.id);
  }
  let legacyRows = [];
  try { legacyRows = await listProgress(); } catch (e) { /* 后端可能无该接口 */ }
  for (const p of legacyRows) {
    if (p && (p.projectId || p.project_id)) pids.add(p.projectId || p.project_id);
  }
  if (pids.size === 0) return [];
  const all = [];
  await Promise.all([...pids].map(async (pid) => {
    try {
      const res = await apiListTasks(pid);
      for (const row of res.tasks || []) {
        const t = apiRowToTask(row);
        if (t) all.push(t);
      }
    } catch (e) { /* 项目可能刚被删除 */ }
  }));
  const withTasks = new Set(all.map(t => String(t.projectId)));
  for (const p of legacyRows) {
    if (!p || !(p.projectId || p.project_id)) continue;
    if (withTasks.has(String(p.projectId || p.project_id))) continue;
    if ((Number(p.lastCompleted ?? p.last_completed ?? 0)) >= (Number(p.totalChunks ?? p.total_chunks ?? 0))) continue;
    all.push(legacyRowToTask(p));
  }
  return all;
}

// 小工具：把任务清单更新到 store
async function refreshTasks(set, get) {
  const tasks = await fetchAllTasks(get);
  set({ tasks });
  return tasks;
}

export const useStore = create((set, get) => {
  // 安装 task bridge
  installTaskBridge(set, get);

  // LLM model fetch ordering guard: stale responses must not overwrite newer ones
  let llmFetchSeq = 0;

  return {
  // ==================== 基础状态====================
  projects: [],
  projectError: '',       // v22.1：项目列表加载错误
  currentProjectId: null,
  nodes: [],
  edges: [],
  isAnalyzing: false,
  isLoadingProject: false,
  progress: 0,
  systemPrompt: config.systemPrompt,
  chunkSize: config.defaultChunkSize,
  debug: config.debug,
  llmModels: [],
  currentLlmId: null,

  // ==================== v24 任务管理 ====================
  tasks: [],
  runStats: { successCount: 0, failedCount: 0, totalChunks: 0 },
  activeProgress: null,     // { completed, total, failedCount, rateLimitCount, degraded }
  isPaused: false,

  // ==================== v21 主题 ====================
  theme: localStorage.getItem('storymap.theme') || 'ink',

  // ==================== v26 图谱状态====================
  viewMode: 'all',          // 'all' | 'merged' | 'unique'
  minAppearances: 2,        // v2.4：X 次起阈值，仅viewMode === 'merged' 时生效（2-10）
  graphRange: { from: 0, to: 0 },  // 0 = 不限
  graphScope: 'preview',    // 'preview' | 'all' | 'custom'；默认只渲染前5 章
  edgeLabelLines: (() => {
    const v = parseInt(localStorage.getItem('storymap:edge-label-lines'), 10);
    return [1, 2, 3, 5].includes(v) ? v : 1;
  })(),
  selectedNodeId: null,

  // v26.1
  textMeta: null,
  pastedText: '',

  // ==================== v20 章节范围 ====================
  chapterFrom: 0,
  chapterTo: 0,
  textChapterRanges: [],    // detectChapterRanges 结果

  // ==================== v18 失败记录 ====================
  lastFailure: null,        // { chunks[], totalChunks, chunkSize }

  // ==================== Actions ====================

  setChunkSize: (size) => {
    set({ chunkSize: size });
    const cfg = loadConfig();
    cfg.defaultChunkSize = size;
    saveConfig(cfg);
  },

  setDebug: (dbg) => {
    set({ debug: dbg });
    const cfg = loadConfig();
    cfg.debug = dbg;
    saveConfig(cfg);
  },

  setSystemPrompt: (prompt) => {
    set({ systemPrompt: prompt });
    const cfg = loadConfig();
    cfg.systemPrompt = prompt;
    saveConfig(cfg);
  },

  // v21：主题
  setTheme: (theme) => {
    set({ theme });
    localStorage.setItem('storymap.theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  },

  // v26：视图模式
  setViewMode: (mode) => set({ viewMode: mode }),
  setMinAppearances: (n) => {
    const v = Math.max(2, Math.min(10, Math.floor(Number(n) || 2)));
    set({ minAppearances: v });
  },

  // v26：图谱范围
  setGraphRange: (range) => set({ graphRange: range }),
  setGraphScope: (scope) => set({ graphScope: scope }),

  // v26：边标签行数
  setEdgeLabelLines: (lines) => {
    const valid = [1, 2, 3, 5].includes(lines) ? lines : 1;
    set({ edgeLabelLines: valid });
    localStorage.setItem('storymap:edge-label-lines', String(valid));
  },

  // v26：选中节点
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  // v20：章节范围
  setChapterRange: (from, to) => set({ chapterFrom: from, chapterTo: to }),
  setTextChapterRanges: (ranges) => set({ textChapterRanges: ranges }),

  // v26.1
  setTextMeta: (meta) => set({ textMeta: meta }),
  setPastedText: (t) => set({ pastedText: t }),

  // v26.4: Upload path - fetch chapters from backend.
  fetchProjectChapters: async (pid) => {
    if (!pid) return [];
    try {
      const r = await fetch(`${API_BASE}/projects/${pid}/chapters`);
      const data = await r.json();
      if (data.status === 'success') {
        set({ textChapterRanges: data.ranges || [] });
        return data.ranges || [];
      }
    } catch (e) {
      console.warn('fetchProjectChapters failed:', e);
    }
    return [];
  },  clearTextState: () => set({ textMeta: null, pastedText: '' }),

  uploadProjectText: async (projectId, text, encoding) => {
    if (!projectId) throw new Error('uploadProjectText: projectId required');
    if (typeof text !== 'string' || !text.length) {
      throw new Error('uploadProjectText: text required and non-empty');
    }
    const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/text`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, encoding: encoding || 'utf-8' }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    const r = await res.json();
    return { chars: r.chars, encoding: r.encoding, updatedAt: r.updatedAt || Date.now() };
  },

  fetchProjectText: async (projectId) => {
    if (!projectId) return null;
    const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/text`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  // v24：任务管理actions
  pauseTaskById: async (id) => {
    const t = (get().tasks || []).find(x => x.id === id);
    if (!t) return;
    try { await apiPatchTask(t.projectId, id, { action: 'pause' }); } catch (e) { console.warn('pauseTaskById', e); }
    await refreshTasks(set, get);
  },
  resumeTaskById: async (id) => {
    const t = (get().tasks || []).find(x => x.id === id);
    if (!t) return;
    try { await apiPatchTask(t.projectId, id, { action: 'resume' }); } catch (e) { console.warn('resumeTaskById', e); }
    await refreshTasks(set, get);
  },
  cancelTaskById: async (id) => {
    const t = (get().tasks || []).find(x => x.id === id);
    if (!t) return;
    try { await apiPatchTask(t.projectId, id, { action: 'cancel' }); } catch (e) { console.warn('cancelTaskById', e); }
    await refreshTasks(set, get);
  },
  removeTaskById: async (id) => {
    const t = (get().tasks || []).find(x => x.id === id);
    if (!t) return;
    try { await apiDeleteTask(t.projectId, id); } catch (e) { console.warn('removeTaskById', e); }
    await refreshTasks(set, get);
  },
  updateTaskParams: async (id, patch) => {
    const t = (get().tasks || []).find(x => x.id === id);
    if (!t) return;
    if (patch && Number.isFinite(patch.concurrency) && patch.concurrency > 0) {
      try { await apiPatchTask(t.projectId, id, { action: 'set_concurrency', concurrency: patch.concurrency }); } catch (e) { console.warn('updateTaskParams set_concurrency', e); }
    }
    // chunkSize 变化在剩下任务终止后由 store 更新
    if (patch && Number.isFinite(patch.chunkSize) && patch.chunkSize > 0) {
      const tasks = (get().tasks || []).map(x => x.id === id ? { ...x, chunkSize: patch.chunkSize } : x);
      set({ tasks });
    }
    await refreshTasks(set, get);
  },

  // v28-fix: 引擎任务（后端 tasks 表）中断后继续 —— 用任务行自己的参数建续跑任务
  continueEngineTask: async (taskId) => {
    const t = (get().tasks || []).find(x => x.id === taskId);
    if (!t || !t.projectId) return;
    const concurrency = Number.isFinite(t.concurrency) && t.concurrency > 0
      ? Math.min(8, Math.max(1, t.concurrency))
      : 3;
    try {
      const payload = t.kind === 'retry'
        ? {
            kind: 'retry',
            chunk_size: t.chunkSize || 1000,
            concurrency,
            llm_model_id: t.llmModelId,
            system_prompt: t.systemPrompt || '',
            old_chunk_size: t.chunkSize || 1000,
            failure_indexes: (t.failedChunks || []).map(c => c.chunkIndex),
            text: null,
          }
        : {
            kind: 'continue',
            chunk_size: t.chunkSize || 1000,
            concurrency,
            llm_model_id: t.llmModelId,
            system_prompt: t.systemPrompt || '',
            chapter_from: t.chapterFrom || '',
            chapter_to: t.chapterTo || '',
            start_index: t.lastCompleted || 0,
            text: null,
          };
      const created = await apiCreateTask(t.projectId, payload);
      // 旧任务行不再以「待继续」展示
      try { await apiPatchTask(t.projectId, taskId, { action: 'cancel' }); } catch {}
      set({ isAnalyzing: true, progress: 0, isPaused: false });
      await refreshTasks(set, get);
      return created;
    } catch (e) {
      if (e && (e.errorCode === 'task_already_active' || e.status === 409)) {
        alert('该项目已有进行中的任务');
        return;
      }
      console.error('continueEngineTask failed:', e);
      alert('续跑失败：' + (e?.message || e));
    }
  },

  clearProjectError: () => set({ projectError: '' }),

  // ==================== LLM 模型管理 ====================

  fetchLlmModels: async () => {
    const seq = ++llmFetchSeq;
    try {
      const res = await fetch(`${API_BASE}/llm-models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== llmFetchSeq) return;
      if (!Array.isArray(data)) return;
      if (data.length === 0) {
        set({ llmModels: [], currentLlmId: null });
        writeSelectedLlmId(localStorage, null);
        return;
      }
      const resolved = resolveSelectedLlmId(data, {
        currentId: get().currentLlmId,
        persistedId: readSelectedLlmId(localStorage),
      });
      set({ llmModels: data, currentLlmId: resolved });
      writeSelectedLlmId(localStorage, resolved);
    } catch (e) {
      console.error('fetch LLM models failed', e);
    }
  },

  addLlmModel: async (model) => {
    try {
      const res = await fetch(`${API_BASE}/llm-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model)
      });
      const r = await res.json();
      if (r.status === 'success') {
        await get().fetchLlmModels();
        return { success: true, id: r.id };
      }
      return { success: false, message: r.message };
    } catch (e) {
      return { success: false, message: e.message };
    }
  },

  updateLlmModel: async (id, model) => {
    try {
      const res = await fetch(`${API_BASE}/llm-models/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model)
      });
      const r = await res.json();
      if (r.status === 'success') {
        await get().fetchLlmModels();
        return { success: true };
      }
      return { success: false };
    } catch (e) {
      return { success: false };
    }
  },

  deleteLlmModel: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/llm-models/${id}`, { method: 'DELETE' });
      const r = await res.json();
      if (r.status === 'success') {
        await get().fetchLlmModels();
        return { success: true };
      }
      return { success: false };
    } catch (e) {
      return { success: false };
    }
  },

  testLlmModel: async (cfg) => {
    try {
      const res = await fetch(`${API_BASE}/llm-models/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
      });
      return await res.json();
    } catch (e) {
      return { status: 'error', message: e.message };
    }
  },

  selectLlmModel: (id) => {
    const matched = get().llmModels.find(m => String(m.id) === String(id))?.id ?? null;
    set({ currentLlmId: matched });
    writeSelectedLlmId(localStorage, matched);
  },

  // ==================== 项目管理 ====================

  fetchProjects: async () => {
    try {
      const res = await fetch(`${API_BASE}/projects`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ projects: data, projectError: '' });
    } catch (e) {
      console.error("获取项目失败", e);
      set({ projectError: e.message });
    }
  },

  selectProject: async (pid) => {
    const currentId = pid; // v24.4.6：late-response 防护
    set({
      currentProjectId: pid,
      nodes: [],
      edges: [],
      isLoadingProject: true,
      projectError: '',
      selectedNodeId: null,
      graphRange: { from: 0, to: 0 },
      graphScope: 'preview',
      textMeta: null,    // v26.1
      pastedText: '',    // v26.1
    });

    const startTime = Date.now();
    try {
      const res = await fetch(`${API_BASE}/projects/${pid}/data`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // v24.4.6：检查是否仍是当前项目
      if (get().currentProjectId !== currentId) return;

      const elapsed = Date.now() - startTime;
      if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed));

      set({
        nodes: data.nodes || [],
        edges: data.edges || [],
        isLoadingProject: false,
      });

      // 加载失败记录
      const failure = await getFailure(pid);
      if (failure) set({ lastFailure: failure });
      else set({ lastFailure: null });
    } catch (e) {
      console.error("获取项目数据失败", e);
      if (get().currentProjectId === currentId) {
        set({ nodes: [], edges: [], isLoadingProject: false, projectError: e.message });
      }
    }
  },

  createProject: async (name) => {
    if (!name.trim()) return;
    try {
      set({ projectError: '' });
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (res.status === 409) {
        const r = await res.json();
        set({ projectError: `重名：${r.existing_id}` });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const p = await res.json();
      await get().fetchProjects();
      await get().selectProject(p.id);
    } catch (e) {
      console.error("创建项目失败", e);
      throw e;
    }
  },

  deleteProject: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' });
      if (res.ok) {
        // v28: 后端 FK CASCADE 处理\uff1b剩下 task 记录被删除
        await get().fetchProjects();
        if (get().currentProjectId === id) {
          set({ currentProjectId: null, nodes: [], edges: [], isLoadingProject: false, projectError: '', lastFailure: null, tasks: [] });
        }
      }
    } catch (e) {
      console.error("删除项目失败", e);
    }
  },

  renameProject: async (id, newName) => {
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      if (res.status === 409) {
        set({ projectError: '项目名已存在' });
        return;
      }
      if (res.ok) await get().fetchProjects();
    } catch (e) {
      console.error("重命名项目失败", e);
    }
  },

  // ==================== v24 炼化（走 taskManager）===================

  updateProjectDescription: async (pid, description) => {
    const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(pid)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', description }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    await get().fetchProjects();
    return { ok: true };
  },

  analyzeText: async (text, concurrency = 3, chunkSizeOverride) => {
    // v28: 后端任务引擎
    const { currentProjectId, currentLlmId, llmModels, systemPrompt, chapterFrom, chapterTo } = get();
    const chunkSize = chunkSizeOverride ?? get().chunkSize;
    if (!currentProjectId) return;
    if (text != null && !text.trim()) return;

    const selectedModel = llmModels.find(m => m.id === currentLlmId);
    if (!selectedModel) {
      alert("请先在模型管理中配置并选择一个 LLM 模型");
      return;
    }

    try {
      // 粘贴 / 小文本：传 text 到后端
      // 大文本（传 null）：后端按 project_id 取原文
      const useText = (text != null && text.trim()) ? text : null;
      const created = await apiCreateTask(currentProjectId, {
        kind: 'analyze',
        chunk_size: chunkSize,
        concurrency,
        llm_model_id: currentLlmId,
        system_prompt: systemPrompt,
        chapter_from: chapterFrom ? String(chapterFrom) : '',
        chapter_to: chapterTo ? String(chapterTo) : '',
        text: useText,
      });
      set({ isAnalyzing: true, progress: 0, isPaused: false });
      await refreshTasks(set, get);
      // 刷新项目数据
      get().selectProject(currentProjectId);
      return created;
    } catch (e) {
      if (e && (e.errorCode === 'task_already_active' || e.status === 409)) {
        alert('请注意：该项目已有进行中的任务');
        return;
      }
      if (e && e.errorCode === 'project_text_not_found') {
        alert('请先导入文本（大文本模式）');
        return;
      }
      console.error('analyzeText failed:', e);
      alert('创建任务失败：' + (e?.message || e));
    }
  },

  // v27-fix: 接受卡片上的 overrides。卡片编辑过的并发/分片优先于后端断点旧值。
  // overrides = { chunkSize?: number, concurrency?: number } —— 未传或非法值回落 progress。
  // overrides = { chunkSize?: number, concurrency?: number }
  continueAnalysis: async (overrides = {}) => {
    const { currentProjectId, currentLlmId, llmModels, systemPrompt } = get();
    if (!currentProjectId) return;

    const selectedModel = llmModels.find(m => m.id === currentLlmId);
    if (!selectedModel) return;

    let progress;
    let chunkSize;
    try {
      const { getProgress } = await import('./progressStore.js');
      progress = await getProgress(currentProjectId);
      if (!progress) {
        alert('未找到断点记录，请重新发起分析');
        return;
      }
      const overrideChunkSize = Number.isFinite(overrides?.chunkSize) && overrides.chunkSize > 0
        ? overrides.chunkSize : null;
      chunkSize = overrideChunkSize != null ? overrideChunkSize : progress.chunkSize;
      if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
        alert('断点记录缺少有效的chunkSize，请重新发起分析');
        return;
      }
      const concurrency = Number.isFinite(overrides?.concurrency) && overrides.concurrency > 0
        ? Math.min(8, Math.max(1, overrides.concurrency))
        : (progress.concurrency || 3);
      // v28: 后端 POST tasks (kind=continue)
      const created = await apiCreateTask(currentProjectId, {
        kind: 'continue',
        chunk_size: chunkSize,
        concurrency,
        llm_model_id: currentLlmId,
        system_prompt: systemPrompt,
        chapter_from: progress.chapterFrom || '',
        chapter_to: progress.chapterTo || '',
        start_index: progress.lastCompleted || 0,
        // 大文本：text=null 后端按 project_id 取原文
        text: null,
      });
      set({ isAnalyzing: true, progress: 0, isPaused: false });
      // v28-fix: 旧断点已迁入后端任务，清掉以免下次轮询重复显示「已中断」卡
      try { await clearProgress(currentProjectId); } catch {}
      await refreshTasks(set, get);
      get().selectProject(currentProjectId);
      return created;
    } catch (e) {
      if (e && (e.errorCode === 'task_already_active' || e.status === 409)) {
        alert('请注意：该项目已有进行中的任务');
        return;
      }
      console.error('continueAnalysis failed:', e);
      alert('续跑分析失败：' + (e?.message || e));
    }
  },

  retryFailedChunks: async (chunkSize, concurrency) => {
    const { currentProjectId, currentLlmId, llmModels, systemPrompt, lastFailure } = get();
    if (!currentProjectId || !lastFailure?.chunks?.length) return;
    const cs = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : lastFailure.chunkSize;
    if (!Number.isFinite(cs) || cs <= 0) return;

    const selectedModel = llmModels.find(m => m.id === currentLlmId);
    if (!selectedModel) return;

    try {
      // v28: 后端 retry
      const failureIndexes = (lastFailure.chunks || []).map(c => c.chunkIndex);
      const oldChunkSize = lastFailure.chunkSize || cs;
      const created = await apiCreateTask(currentProjectId, {
        kind: 'retry',
        chunk_size: cs,
        concurrency,
        llm_model_id: currentLlmId,
        system_prompt: systemPrompt,
        old_chunk_size: oldChunkSize,
        failure_indexes: failureIndexes,
        text: null,  // 大文本模式
      });
      set({ isAnalyzing: true, progress: 0, isPaused: false });
      await refreshTasks(set, get);
      get().selectProject(currentProjectId);
      // 重试后清除失败记录
      try { await clearFailure(currentProjectId); } catch {}
      set({ lastFailure: null });
      return created;
    } catch (e) {
      if (e && (e.errorCode === 'task_already_active' || e.status === 409)) {
        alert('请注意：该项目已有进行中的任务');
        return;
      }
      console.error('retryFailedChunks failed:', e);
      alert('重试失败：' + (e?.message || e));
    }
  },

  // v28: 后端 task 轮询控制
  startBackendTaskPolling: () => { startBackendTaskPolling(set, get); },
  stopBackendTaskPolling: () => { stopBackendTaskPolling(); },
  refreshTasksNow: async () => { await refreshTasks(set, get); return get().tasks; },

  // v28: 后端命令
  pauseAnalysis: () => {
    const { tasks } = get();
    const active = (tasks || []).find(t => t.status === 'running');
    if (active) get().pauseTaskById(active.id);
  },

  resumeAnalysis: () => {
    const { tasks } = get();
    const paused = (tasks || []).find(t => t.status === 'paused');
    if (paused) get().resumeTaskById(paused.id);
  },
  };
});
