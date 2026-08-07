import { create } from 'zustand';
import { API_BASE, loadConfig, saveConfig } from './config.js';
import * as taskManager from './taskManager.js';
import { getFailure, clearFailure } from './failureStore.js';

// 加载配置
const config = loadConfig();

// v24.4.6：清除旧版llm_config（迁移到 llmSelection.js）
try { localStorage.removeItem('llm_config'); } catch {}

// 安装 task bridge（只一次）
let _bridgeInstalled = false;
function installTaskBridge(set, get) {
  if (_bridgeInstalled) return;
  _bridgeInstalled = true;
  // 初始快照
  set({ tasks: taskManager.getTasksSnapshot() });
  // 订阅变更
  taskManager.subscribe(() => {
    set({ tasks: taskManager.getTasksSnapshot() });
  });
}

export const useStore = create((set, get) => {
  // 安装 task bridge
  installTaskBridge(set, get);

  return {
  // ==================== 基础状态====================
  projects: [],
  projectError: null,       // v22.1：项目列表加载错误
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
  pauseTaskById: (id) => taskManager.pauseTask(id),
  resumeTaskById: (id) => taskManager.resumeTask(id),
  cancelTaskById: (id) => taskManager.cancelTask(id),
  removeTaskById: (id) => taskManager.removeTask(id),

  clearProjectError: () => set({ projectError: null }),

  // ==================== LLM 模型管理 ====================

  fetchLlmModels: async () => {
    try {
      const res = await fetch(`${API_BASE}/llm-models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ llmModels: data });
      // 自动选择默认模型
      const defaultModel = data.find(m => m.is_default);
      if (defaultModel && !get().currentLlmId) {
        set({ currentLlmId: defaultModel.id });
      }
    } catch (e) {
      console.error("获取 LLM 模型失败", e);
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
        if (get().currentLlmId === id) set({ currentLlmId: null });
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

  selectLlmModel: (id) => set({ currentLlmId: id }),

  // ==================== 项目管理 ====================

  fetchProjects: async () => {
    try {
      const res = await fetch(`${API_BASE}/projects`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ projects: data, projectError: null });
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
      const failure = getFailure(pid);
      if (failure) set({ lastFailure: failure });
      else set({ lastFailure: null });
    } catch (e) {
      console.error("获取项目数据失败", e);
      if (get().currentProjectId === currentId) {
        set({ nodes: [], edges: [], isLoadingProject: false });
      }
    }
  },

  createProject: async (name) => {
    if (!name.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (res.status === 409) {
        const r = await res.json();
        set({ projectError: `重名：{r.existing_id}` });
        return;
      }
      const p = await res.json();
      await get().fetchProjects();
      get().selectProject(p.id);
    } catch (e) {
      console.error("创建项目失败", e);
    }
  },

  deleteProject: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await get().fetchProjects();
        if (get().currentProjectId === id) {
          set({ currentProjectId: null, nodes: [], edges: [] });
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

  analyzeText: async (text, concurrency = 3, chunkSizeOverride) => {
    // v26.3：传 chunkSizeOverride 时优先使用（导入页面最新值），fallback 到store 全局
    const { currentProjectId, currentLlmId, llmModels, systemPrompt, chapterFrom, chapterTo } = get();
    const chunkSize = chunkSizeOverride ?? get().chunkSize;
    if (!currentProjectId) return;
    if (text != null && !text.trim()) return;

    const selectedModel = llmModels.find(m => m.id === currentLlmId);
    if (!selectedModel) {
      alert("请先在模型管理'中配置并选择一个LLM 模型");
      return;
    }

    // v26.1：text=null 时不传全文到 taskManager
    // v26.2：createAnalyzeTask 异步（text=null 时拉 chunk-metas）
    const task = await taskManager.createAnalyzeTask({
      projectId: currentProjectId,
      projectName: get().projects.find(p => p.id === currentProjectId)?.name || '',
      modelName: selectedModel.name,
      modelId: currentLlmId,
      systemPrompt,
      text: text,  // null = 后端加载
      chunkSize,
      concurrency,
      chapterFrom: chapterFrom || undefined,
      chapterTo: chapterTo || undefined,
    });

    if (!task) {
      alert('该项目已有进行中的任务');
      return;
    }

    // 订阅进度
    const unsub = taskManager.subscribeTask(task.id, (t) => {
      set({
        runStats: { successCount: t.successCount, failedCount: t.failedCount, totalChunks: t.total },
        activeProgress: { completed: t.completed, total: t.total, failedCount: t.failedCount, rateLimitCount: t.rateLimitCount, degraded: t.degraded },
        isPaused: t.status === 'paused',
        progress: t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0,
      });

      if (['completed', 'failed', 'cancelled'].includes(t.status)) {
        set({ isAnalyzing: false, progress: 0, activeProgress: null });
        unsub();
        // 刷新项目数据
        if (t.status === 'completed') {
          get().selectProject(currentProjectId);
        }
        // 保存失败记录
        if (t.failedChunks?.length) {
          set({ lastFailure: { chunks: t.failedChunks, totalChunks: t.total, chunkSize } });
        }
      }
    });

    set({ isAnalyzing: true, progress: 0, isPaused: false });
  },

  continueAnalysis: async () => {
    const { currentProjectId, currentLlmId, llmModels, systemPrompt } = get();
    if (!currentProjectId) return;

    const selectedModel = llmModels.find(m => m.id === currentLlmId);
    if (!selectedModel) return;

    let task;
    let chunkSize;
    try {
      // v25 修复：从 progressStore 拉单条断点详情（含原文），createContinueTask 需要progress 字段
      const { getProgress } = await import('./progressStore.js');
      const progress = await getProgress(currentProjectId);
      if (!progress) {
        alert('未找到断点记录，请重新发起分析');
        return;
      }
      chunkSize = progress.chunkSize;
      if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
        alert('断点记录缺少有效的chunkSize，请重新发起分析');
        return;
      }

      // v26.2：createContinueTask 异步（progress.text 为空时拉 chunk-metas）
      task = await taskManager.createContinueTask({
      projectId: currentProjectId,
      projectName: get().projects.find(p => p.id === currentProjectId)?.name || '',
      modelName: selectedModel.name,
      modelId: currentLlmId,
      systemPrompt,
      chunkSize,
      progress,
    });

      if (!task) {
        alert('该项目已有进行中的任务');
        return;
      }

      const unsub = taskManager.subscribeTask(task.id, (t) => {
        set({
          runStats: { successCount: t.successCount, failedCount: t.failedCount, totalChunks: t.total },
          activeProgress: { completed: t.completed, total: t.total, failedCount: t.failedCount, rateLimitCount: t.rateLimitCount, degraded: t.degraded },
          isPaused: t.status === 'paused',
          progress: t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0,
        });

        if (['completed', 'failed', 'cancelled'].includes(t.status)) {
          set({ isAnalyzing: false, progress: 0, activeProgress: null });
          unsub();
          if (t.status === 'completed') get().selectProject(currentProjectId);
          if (t.failedChunks?.length) {
            set({ lastFailure: { chunks: t.failedChunks, totalChunks: t.total, chunkSize } });
          }
        }
      });

      set({ isAnalyzing: true, progress: 0, isPaused: false });
    } catch (err) {
      console.error('continueAnalysis failed:', err);
      alert('继续分析失败：'+ (err?.message || err));
    }
  },

  retryFailedChunks: async () => {
    const { currentProjectId, currentLlmId, llmModels, systemPrompt, lastFailure } = get();
    if (!currentProjectId || !lastFailure?.chunks?.length) return;
    const chunkSize = lastFailure.chunkSize;
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) return;

    const selectedModel = llmModels.find(m => m.id === currentLlmId);
    if (!selectedModel) return;

    // v26.2：createRetryFailedTask 异步（failure.text 为空时拉 chunk-metas）
    const task = await taskManager.createRetryFailedTask({
      projectId: currentProjectId,
      projectName: get().projects.find(p => p.id === currentProjectId)?.name || '',
      modelName: selectedModel.name,
      modelId: currentLlmId,
      systemPrompt,
      chunkSize,
      failedChunks: lastFailure.chunks,
      totalChunks: lastFailure.totalChunks,
    });

    if (!task) {
      alert('该项目已有进行中的任务');
      return;
    }

    const unsub = taskManager.subscribeTask(task.id, (t) => {
      set({
        runStats: { successCount: t.successCount, failedCount: t.failedCount, totalChunks: t.total },
        activeProgress: { completed: t.completed, total: t.total, failedCount: t.failedCount, rateLimitCount: t.rateLimitCount, degraded: t.degraded },
        isPaused: t.status === 'paused',
        progress: t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0,
      });

      if (['completed', 'failed', 'cancelled'].includes(t.status)) {
        set({ isAnalyzing: false, progress: 0, activeProgress: null });
        unsub();
        if (t.status === 'completed') {
          get().selectProject(currentProjectId);
          clearFailure(currentProjectId);
          set({ lastFailure: null });
        }
      }
    });

    set({ isAnalyzing: true, progress: 0, isPaused: false });
  },

  // v20：暂停继续
  pauseAnalysis: () => {
    const { tasks } = get();
    const active = tasks.find(t => t.status === 'running');
    if (active) taskManager.pauseTask(active.id);
  },

  resumeAnalysis: () => {
    const { tasks } = get();
    const paused = tasks.find(t => t.status === 'paused');
    if (paused) taskManager.resumeTask(paused.id);
  },

  // 清除失败记录
  clearLastFailure: () => {
    const { currentProjectId } = get();
    if (currentProjectId) clearFailure(currentProjectId);
    set({ lastFailure: null });
  },

  // ==================== 导入/导出 ====================

  exportProject: async () => {
    const { currentProjectId, projects } = get();
    if (!currentProjectId) { alert('请先选择一个项目'); return; }
    try {
      const res = await fetch(`${API_BASE}/projects/${currentProjectId}/export`);
      const data = await res.json();
      const project = projects.find(p => p.id === currentProjectId);
      const exportData = {
        project: { name: project?.name || 'Untitled' },
        nodes: data.nodes || [],
        edges: data.edges || []
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project?.name || 'project'}_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('导出项目失败', e);
    }
  },

  importProject: async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await fetch(`${API_BASE}/projects/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await res.json();
      if (result.status === 'success') {
        await get().fetchProjects();
        await get().selectProject(result.project_id);
      } else {
        throw new Error(result.message || '导入失败');
      }
    } catch (e) {
      console.error('导入项目失败', e);
      alert('导入失败: ' + e.message);
    }
  },

  cleanupDuplicates: async (projectId) => {
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/cleanup`, { method: 'POST' });
      const result = await res.json();
      if (result.status === 'success') {
        await get().selectProject(projectId);
        return result;
      }
    } catch (e) {
      console.error("清理失败", e);
      return null;
    }
  },
  };
});
