/**
 * 小说剧本智能分析工作台
 * 视觉对齐：A-commercial.html（用户确认版）
 * 布局：顶栏 / 左侧窄导航 / 项目库+文本分析 / 关系图谱主区 / 人物档案 / 关系演化时间线
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import './App.css';
import GraphView from './GraphView';
import LLMManager from './LLMManager';
import { useStore } from './store.js';
import { loadConfig, saveConfig } from './config.js';
import TaskPanel, { useTaskCounts } from './TaskPanel.jsx';
import CharacterInspector from './CharacterInspector.jsx';
import RelationshipTimeline from './RelationshipTimeline.jsx';
import { decodeFileText, isSmallPasteText } from './encodingDetect.js';
import {
  buildCharacterProfile, buildRelationshipTracks, getChapters,
  filterByViewMode, filterByChapter, filterByChapterRange,
  getOrphanedNodeIds, buildChapterInsight, limitGraphPreview,
} from './narrativeModel.js';
import { buildNarrativeCover } from './narrativeCover.js';
import { detectChapterRanges } from './chapterSplitter.js';
import { filterChapters } from './chapterSearch.js';
import { buildTaskGuide } from './taskGuide.js';
import { listProgress } from './progressStore.js';

// ==================== 主题配置 ====================
const THEMES = [
  { id: 'narrative-light', name: '商业浅色', bg: '#f5f3ee', fg: '#1a1a1a', accent: '#b8323a' },
  { id: 'ink', name: '水墨', bg: '#f5f5f0', fg: '#1a1a1a', accent: '#c04820' },
  { id: 'dawn', name: '晨读橘光', bg: '#fdf6ee', fg: '#2c2418', accent: '#d45a20' },
  { id: 'cloud', name: '云岫书卷', bg: '#f0f4f8', fg: '#1e293b', accent: '#3b82f6' },
  { id: 'daylight', name: '日光清晰', bg: '#ffffff', fg: '#111827', accent: '#b91c1c' },
  { id: 'night', name: '夜航墨蓝', bg: '#0f1724', fg: '#e2e8f0', accent: '#60a5fa' },
  { id: 'slate', name: '远见蓝灰', bg: '#f1f5f9', fg: '#0f172a', accent: '#475569' },
];

// ==================== SVG 图标（内联，不引入外部库）====================
const Icons = {
  // 侧导航：项目 / 图谱 / 任务 / 模型 / 配置
  project: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M3 4a2 2 0 012-2h3l2 2h6a2 2 0 012 2v1H3V4z"/>
      <path fillRule="evenodd" d="M3 7h14v7a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" clipRule="evenodd"/>
    </svg>
  ),
  graph: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="6" r="2"/>
      <circle cx="15" cy="14" r="2"/>
      <circle cx="15" cy="6" r="1.5"/>
      <path d="M7 7l6 5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
    </svg>
  ),
  task: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm1 11H9v-2h2v2zm0-4H9V5h2v4z"/>
    </svg>
  ),
  model: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 2a1 1 0 01.707.293l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 9l-5.293-5.293A1 1 0 0110 2z"/>
      <path d="M3 10a1 1 0 011-1h8a1 1 0 110 2H4a1 1 0 01-1-1z"/>
    </svg>
  ),
  timeline: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <circle cx="4" cy="10" r="1.6"/>
      <circle cx="10" cy="4.5" r="1.6"/>
      <circle cx="10" cy="15.5" r="1.6"/>
      <circle cx="16" cy="10" r="1.6"/>
      <path d="M5.4 9L9 5.5M5.4 11l3.6 3.5M11.4 5.5l3.2 3.2M11.4 14.5l3.2-3.2" stroke="currentColor" strokeWidth="1.2" fill="none"/>
    </svg>
  ),
  config: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/>
    </svg>
  ),
  search: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd"/>
    </svg>
  ),
  close: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
    </svg>
  ),
  fullscreen: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M3 3h4v2H5v2H3V3zm10 0h4v4h-2V5h-2V3zM3 13h2v2h2v2H3v-4zm12 2h-2v2h4v-4h-2v2z"/>
    </svg>
  ),
  collapse: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/>
    </svg>
  ),
  expand: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z"/>
    </svg>
  ),
  import: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"/>
    </svg>
  ),
  export: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z"/>
    </svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10 2a8 8 0 100 16 8 8 0 000-16zM9 8h2v6H9V8zm0-3h2v2H9V5z" clipRule="evenodd"/>
    </svg>
  ),
  // 关系类型徽标用的小图标（无 — 文字徽标即可）
};

// 视图模式（保持原 id 与逻辑，仅渲染层标签与 mockup 文案对齐）
const VIEW_MODES = [
  { id: 'all', label: '全部出现' },
  { id: 'multi', label: '多次出现' },  // v2.4：渲染时根据 s.minAppearances 动态显示 "X 次起"
  { id: 'single', label: '仅出现一次' },
];

// v2.4：阈值 popover 状态
const VIEW_MODE_IDS = { ALL: 'all', MULTI: 'multi', SINGLE: 'single' };

export default function App() {
  const s = useStore();

  // ==================== 本地状态 ====================
  const [newProjectName, setNewProjectName] = useState('');
  const [showLLMManager, setShowLLMManager] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeRail, setActiveRail] = useState('project');
  const [projectSearch, setProjectSearch] = useState('');
  const [editingProjectId, setEditingProjectId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [toast, setToast] = useState(null);
  const [debug, setDebug] = useState(false);
  const [chunkSize, setChunkSize] = useState(500);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [concurrency, setConcurrency] = useState(2);
  const [chapterSearchTerm, setChapterSearchTerm] = useState('');
  const fromColRef = useRef(null);
  const toColRef = useRef(null);
  const [showChapterPicker, setShowChapterPicker] = useState(false);
  const [showTimelineDrawer, setShowTimelineDrawer] = useState(false);
  const [showProjectDrawer, setShowProjectDrawer] = useState(false);
  const [showTaskDrawer, setShowTaskDrawer] = useState(false);
  const [showThresholdPopover, setShowThresholdPopover] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem('storymap.focusModeDismissed') === null;
    } catch {
      return false;
    }
  });
  const [showFocusHint, setShowFocusHint] = useState(false);

  const textFileLabelRef = useRef(null);
  const drawerTextFileRef = useRef(null);  // v2.5：抽屉内「导入文本」独立 file input，避免与顶栏共享导致的时序/状态耦合问题
  const chapterPickerRef = useRef(null);

  // ==================== 初始化 ====================
  useEffect(() => {
    const cfg = loadConfig();
    setDebug(cfg.debug);
    setChunkSize(cfg.defaultChunkSize);
    setSystemPrompt(cfg.systemPrompt);
  }, []);

  useEffect(() => {
    s.fetchProjects().then(() => s.refreshTasksNow()).catch(() => {});
    s.fetchLlmModels();
    // v28: 后端引擎在 boot 时暂停 task 状态\uff1bApp 启动 store 的后端 task 轮询。
    s.startBackendTaskPolling();
    return () => s.stopBackendTaskPolling();
  }, []);

  // 主题
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', s.theme);
  }, [s.theme]);


  // 章节范围检测（文本章节，仅供 refine 切片用）
  // v26.1：仅粘贴路径前端持有全文；上传路径前端无原文，跳过检测（后端分析时自取）。
  useEffect(() => {
    const pasted = (s.pastedText || '');
    if (pasted.trim()) {
      const ranges = detectChapterRanges(pasted);
      s.setTextChapterRanges(ranges);
    } else {
      s.setTextChapterRanges([]);
    }
  }, [s.pastedText]);

  // v26.4：上传路径下从后端拉取章节范围（项目切换或 textMeta 变化时触发）。
  useEffect(() => {
    if (!s.currentProjectId) return;
    if ((s.pastedText || '').trim()) return;  // 粘贴路径已在前一个 useEffect 里处理
    let cancelled = false;
    s.fetchProjectChapters(s.currentProjectId);
    return () => { cancelled = true; };
  }, [s.currentProjectId, s.textMeta]);
  // v2.4：点击外部关闭阈值 popover
  useEffect(() => {
    if (!showThresholdPopover) return undefined;
    const handler = (e) => {
      if (e.target?.closest?.('.nl-threshold-popover-anchor')) return;
      setShowThresholdPopover(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showThresholdPopover]);

  // ESC 关闭抽屉类弹层 / 退出 focus 模式
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (isFocusMode) { exitFocus(); return; }
      if (showConfig) setShowConfig(false);
      if (showAbout) setShowAbout(false);
      if (showLLMManager) setShowLLMManager(false);
      if (showProjectDrawer) setShowProjectDrawer(false);
      if (showTimelineDrawer) setShowTimelineDrawer(false);
      if (showTaskDrawer) setShowTaskDrawer(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showConfig, showAbout, showLLMManager, showProjectDrawer, showTimelineDrawer, showTaskDrawer, isFocusMode]);

  // focus 模式：首次进入时延迟显示提示气泡，6 秒后自动淡出
  useEffect(() => {
    if (!isFocusMode) {
      setShowFocusHint(false);
      return;
    }
    const t1 = setTimeout(() => setShowFocusHint(true), 500);
    const t2 = setTimeout(() => setShowFocusHint(false), 6500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [isFocusMode]);

  // F 键切换 focus 模式（不在输入框中时生效）
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      e.preventDefault();
      setIsFocusMode(v => !v);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 点击外部关闭章节选择器
  useEffect(() => {
    if (!showChapterPicker) return;
    const handler = (e) => {
      if (chapterPickerRef.current && !chapterPickerRef.current.contains(e.target)) {
        setShowChapterPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showChapterPicker]);

  // ==================== 派生数据 ====================
  const currentProject = useMemo(
    () => s.projects.find(p => p.id === s.currentProjectId),
    [s.projects, s.currentProjectId]
  );


  // 文本里的章节范围（给炼化切片 / 进度断点用）
  const chapterOptions = s.textChapterRanges?.length
    ? s.textChapterRanges.map(r => r.title || r.chapter || `第${r.index + 1}章`)
    : [];

  // 图上的章节（从边的 chapter 字段抽取 —— v26.2 起与文本章节分离）
  // v26.4：分析未完成时回退到文本章节（chapterSplitter 检测的），让 picker 在数据到达前可用。
  const graphChapterOptions = useMemo(
    () => {
      const fromEdges = getChapters(s.edges, []);
      return fromEdges.length > 0 ? fromEdges : chapterOptions;
    },
    [s.edges, chapterOptions]
  );

  // v26.4：根据实际章节命名推导术语（章/回），必须在 chapterOptions / graphChapterOptions 声明之后。
  const chapterTerm = useMemo(() => {
    const first = (graphChapterOptions[0] || chapterOptions[0] || '');
    return first.includes('回') ? '回' : '章';
  }, [graphChapterOptions, chapterOptions]);
  // 视图过滤后的边（多次/单次 = viewMode，X 次起阈值 = minAppearances）
  const viewEdges = useMemo(
    () => filterByViewMode(s.edges, s.viewMode, s.minAppearances),
    [s.edges, s.viewMode, s.minAppearances]
  );

  // 范围过滤
  const graphEdges = useMemo(() => {
    let edges = viewEdges;
    if (s.graphRange.chapter) {
      edges = filterByChapter(edges, s.graphRange.chapter);
    }
    const { from, to } = s.graphRange;
    if (from || to) {
      const ranges = graphChapterOptions.map((ch, i) => ({ chapter: ch, start: i }));
      edges = filterByChapterRange(edges, { from, to }, ranges);
    }
    return edges;
  }, [viewEdges, s.graphRange, graphChapterOptions]);

  // 预览限量
  const previewEdges = useMemo(() => {
    if (s.graphScope === 'all' || s.graphScope === 'custom') return graphEdges;
    return limitGraphPreview(graphEdges, { chapterLimit: 5, maxNodes: 150, maxEdges: 300 });
  }, [graphEdges, s.graphScope]);

  // 最终节点/边（剔除孤儿）
  const orphanedIds = useMemo(
    () => getOrphanedNodeIds(s.nodes, previewEdges),
    [s.nodes, previewEdges]
  );
  const displayNodes = useMemo(
    () => s.nodes.filter(n => !orphanedIds.includes(n.id)),
    [s.nodes, orphanedIds]
  );
  const displayEdges = previewEdges;

  // 选中节点的 profile
  const selectedProfile = useMemo(() => {
    if (!s.selectedNodeId) return null;
    return buildCharacterProfile(s.nodes, s.edges, s.selectedNodeId);
  }, [s.selectedNodeId, s.nodes, s.edges]);

  const characterInsight = useMemo(() => {
    if (!selectedProfile) return null;
    return buildChapterInsight(selectedProfile);
  }, [selectedProfile]);

  // focus 模式退出（首次启动后用户主动退出 → 写入 localStorage，不再默认 focus）
  const exitFocus = () => {
    setIsFocusMode(false);
    try { window.localStorage.setItem('storymap.focusModeDismissed', 'true'); } catch {}
  };

  const taskCounts = useTaskCounts();

  // 封面
  const coverData = useMemo(() => {
    if (!currentProject) return null;
    const chapters = getChapters(s.edges, s.nodes);
    return buildNarrativeCover({
      project: currentProject,
      nodes: s.nodes,
      edges: s.edges,
      chapters,
      completedChunks: 0,
      totalChunks: 0,
    });
  }, [currentProject, s.nodes, s.edges]);

  // 时间线数据
  const timelineTracks = useMemo(
    () => buildRelationshipTracks(s.nodes, s.edges),
    [s.nodes, s.edges]
  );

  // 引导
  const guideState = useMemo(() => buildTaskGuide({
    hasProject: !!s.currentProjectId,
    hasText: ((s.pastedText || '').trim().length > 0) || !!s.textMeta,
    hasModel: !!s.currentLlmId,
  }), [s.currentProjectId, s.pastedText, s.textMeta, s.currentLlmId]);

  // 项目过滤
  // v27: search matches name + id; default sort by lastUpdateAt desc
  //      主力项目（最近打开过的）自然沉到顶部
  const filteredProjects = useMemo(() => {
    const term = projectSearch.trim().toLowerCase();
    const matched = term
      ? s.projects.filter(p =>
          (p.name || '').toLowerCase().includes(term) ||
          (p.id || '').toLowerCase().includes(term))
      : s.projects;
    return [...matched].sort((a, b) => (b.lastUpdateAt || 0) - (a.lastUpdateAt || 0));
  }, [s.projects, projectSearch]);

  const filteredChapterOptions = useMemo(() => {
    if (!chapterSearchTerm.trim()) return graphChapterOptions;
    return filterChapters(graphChapterOptions, chapterSearchTerm)
      .map(r => graphChapterOptions[r.originalIndex]);
  }, [graphChapterOptions, chapterSearchTerm]);

  useEffect(() => {
    if (fromColRef.current) fromColRef.current.scrollTop = 0;
    if (toColRef.current) toColRef.current.scrollTop = 0;
  }, [chapterSearchTerm]);

  // 章节范围按钮显示文本
  const chapterRangeLabel = useMemo(() => {
    if (graphChapterOptions.length === 0) return `章节 1—?`;  // 占位，不会显示（按钮已不禁用）
    if (s.graphRange.from || s.graphRange.to) {
      const f = s.graphRange.from || 1;
      const t = s.graphRange.to || graphChapterOptions.length;
      const fromName = graphChapterOptions[f - 1] || `第 ${f} ${chapterTerm}`;
      const toName = graphChapterOptions[t - 1] || `第 ${t} ${chapterTerm}`;
      const trim = (n) => n.length > 6 ? n.slice(0, 5) + '…' : n;
      return f === t ? `章节 ${trim(fromName)}` : `章节 ${trim(fromName)}…→${trim(toName)}…`;
    }
    const end = s.graphScope === 'preview'
      ? Math.min(5, graphChapterOptions.length)
      : graphChapterOptions.length;
    return `章节 1—${end}`;
  }, [graphChapterOptions, s.graphRange, s.graphScope]);

  // 任务计数（rail 任务徽标）
  const activeTaskCount = useMemo(
    () => s.tasks.filter(t => ['running', 'paused', 'interrupted'].includes(t.status)).length,
    [s.tasks]
  );

  // ==================== 回调（逻辑严禁改动）====================
  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleGuide = useCallback((target) => {
    if (target === 'project') { setActiveRail('project'); setSidebarOpen(true); }
    else if (target === 'text') { setActiveRail('project'); setSidebarOpen(true); }
    else if (target === 'model') { setShowLLMManager(true); }
    else if (target === 'analyze') { handleAnalyze(); }
  }, [s.pastedText, s.textMeta, s.currentLlmId, s.currentProjectId]);

  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim()) return;
    await s.createProject(newProjectName.trim());
    setNewProjectName('');
  }, [newProjectName]);

  const handleTextFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!s.currentProjectId) {
      showToast('请先选择项目');
      e.target.value = '';
      return;
    }
    const projectId = s.currentProjectId;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const { text, encoding } = decodeFileText(ev.target.result);
        if (isSmallPasteText(text)) {
          // v26.1：粘贴/小文本走老路径（≤100KB），进 pastedText（textarea 受控）
          s.setPastedText(text);
          s.setTextMeta({
            chars: text.length,
            encoding,
            fileName: file.name,
            hash: '',
            updatedAt: Date.now(),
            source: 'paste',
          });
          showToast(`已导入 ${file.name}（${text.length} 字 / ${encoding}）`);
          return;
        }
        // v26.1：大文本走 PUT 上传；前端只持 meta，不进 textarea
        const r = await s.uploadProjectText(projectId, text, encoding);
        s.setTextMeta({
          chars: r.chars,
          encoding: r.encoding,
          fileName: file.name,
          hash: '',
          updatedAt: r.updatedAt,
          source: 'upload',
        });
        s.setPastedText('');
        showToast(`已上传 ${file.name}（${r.chars} 字 / ${r.encoding}）`);
      } catch (err) {
        console.error('导入文本失败', err);
        showToast(`导入失败：${err.message || err}`);
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  }, [s, showToast]);

  const handleAnalyze = useCallback(() => {
    // v26.1：粘贴路径用 pastedText；导入大文本走 project_id（text=null）
    const hasPasted = (s.pastedText || '').trim();
    const hasMeta = !!s.textMeta;
    if (!hasPasted && !hasMeta) {
      showToast('请先导入或输入文本');
      return;
    }
    if (!s.currentLlmId) { showToast('请先选择 LLM 模型'); return; }
    if (!s.currentProjectId) { showToast('请先选择项目'); return; }
    s.analyzeText(hasPasted ? s.pastedText : null, concurrency, chunkSize);
  }, [s, s.pastedText, s.textMeta, s.currentLlmId, s.currentProjectId, concurrency, chunkSize]);

  const handleExportProject = useCallback(() => {
    s.exportProject();
  }, []);

  const handleImportProject = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) s.importProject(file);
    e.target.value = '';
  }, []);

  // 章节范围（顶栏 + 工作区共享）
  const handleChapterFrom = useCallback((val) => {
    const v = parseInt(val, 10) || 0;
    const to = s.graphRange.to;
    if (v && !to) s.setGraphRange({ from: v, to: v });
    else if (v && to && v > to) s.setGraphRange({ from: v, to: v });
    else s.setGraphRange({ ...s.graphRange, from: v });
    s.setGraphScope('custom');
  }, [s.graphRange]);

  const handleChapterTo = useCallback((val) => {
    const v = parseInt(val, 10) || 0;
    const from = s.graphRange.from;
    if (v && !from) s.setGraphRange({ from: v, to: v });
    else if (v && from && v < from) s.setGraphRange({ from: v, to: v });
    else s.setGraphRange({ ...s.graphRange, to: v });
    s.setGraphScope('custom');
  }, [s.graphRange]);

  const handlePickChapterFromOption = useCallback((idx) => {
    const v = (idx || 0) + 1;
    const to = s.graphRange.to;
    if (v && !to) s.setGraphRange({ from: v, to: v });
    else if (v && to && v > to) s.setGraphRange({ from: v, to: v });
    else s.setGraphRange({ ...s.graphRange, from: v });
    s.setGraphScope('custom');
  }, [s.graphRange]);

  const handlePickChapterToOption = useCallback((idx) => {
    const v = (idx || 0) + 1;
    const from = s.graphRange.from;
    if (v && !from) s.setGraphRange({ from: v, to: v });
    else if (v && from && v < from) s.setGraphRange({ from: v, to: v });
    else s.setGraphRange({ ...s.graphRange, to: v });
    s.setGraphScope('custom');
  }, [s.graphRange]);

  const clearChapterRange = useCallback(() => {
    s.setGraphRange({ from: 0, to: 0 });
  }, []);

  // v27: 相对时间 (e.g. "3 分钟前", "2 小时前", "5 天前")
  const formatRelativeTime = useCallback((ts) => {
    if (!ts) return '';
    const now = Date.now();
    const diff = Math.max(0, now - ts);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return '刚刚';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} 天前`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo} 个月前`;
    return `${Math.floor(mo / 12)} 年前`;
  }, []);
  // 标记搜索高亮渲染
  const renderHighlighted = useCallback((text) => {
    if (!projectSearch || !text) return text;
    const safe = projectSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>');
  }, [projectSearch]);

  // ==================== 渲染 ====================
  return (
    <div className={`nl-app ${isFocusMode ? 'focus-mode' : ''}`}>

      {/* ---- 顶栏：品牌 + 面包屑 + 4 个动作 + 头像 ---- */}
      <header className="nl-topbar">
        <div className="nl-brand">
          <div className="nl-brand-mark">衡</div>
          <span className="nl-brand-name">小说剧本智能分析</span>
          <span className="nl-brand-sub">工作台</span>
        </div>

        <nav className="nl-crumb" aria-label="面包屑">
          <span>项目</span>
          <span className="nl-crumb-sep">/</span>
          {currentProject
            ? <b>{currentProject.name}</b>
            : <span className="nl-crumb-placeholder">未选择项目</span>
          }
          <span className="nl-crumb-sep">/</span>
          <span>IP 关系全景</span>
        </nav>

        <div className="nl-topbar-spacer" />

        <label
          className={`nl-pill ${!s.currentProjectId ? 'is-disabled' : ''}`}
          title={s.currentProjectId ? '导入文本到当前项目' : '请先选择项目'}
          onClick={() => {
            // v2.5 调试日志：诊断 file picker 是否触发
            // eslint-disable-next-line no-console
            console.log('[import-text] topbar label clicked', { projectId: s.currentProjectId, inputDisabled: textFileLabelRef.current?.disabled });
            // 主动调 click() 兜底：某些浏览器（Edge/旧 Safari）label-wrapping-input 可能不触发
            setTimeout(() => textFileLabelRef.current?.click(), 0);
          }}
        >
          导入文本
          <input
            ref={textFileLabelRef}
            type="file"
            accept=".txt"
            onChange={(e) => {
              // eslint-disable-next-line no-console
              console.log('[import-text] topbar file selected', e.target.files?.[0]?.name);
              handleTextFile(e);
            }}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
            disabled={!s.currentProjectId}
          />
        </label>

        <button
          className="nl-pill"
          onClick={handleExportProject}
          disabled={!s.currentProjectId}
          title="导出当前项目"
        >
          导出项目
        </button>

        {/* 导入项目（JSON）— 恢复既有功能入口：label 包隐藏 input 兼容 Edge */}
        <label
          className="nl-pill"
          title="导入项目 JSON 文件"
          style={{ display: 'inline-block', cursor: 'pointer' }}
        >
          导入项目
          <input
            type="file"
            accept=".json"
            onChange={handleImportProject}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          />
        </label>

        <button
          className="nl-pill"
          onClick={() => setShowLLMManager(true)}
          title="模型配置"
        >
          模型配置
        </button>

        <button
          className="nl-pill primary"
          onClick={handleAnalyze}
          disabled={s.isAnalyzing || (!(s.pastedText || '').trim() && !s.textMeta) || !s.currentProjectId || !s.currentLlmId}
          title="运行分析"
        >
          {s.isAnalyzing ? `运行中 ${s.progress}%` : '运行分析'}
        </button>

        <button
          className="nl-topbar-task-btn"
          onClick={() => {
            if (isFocusMode) exitFocus();
            setShowProjectDrawer(false);
            setShowTimelineDrawer(false);
            setShowTaskDrawer(v => !v);
          }}
          title="查看分析任务"
        >
          <span>≡ 任务</span>
          {taskCounts.running + taskCounts.interrupted > 0 && (
            <span className="nl-topbar-task-badge">{taskCounts.running + taskCounts.interrupted}</span>
          )}
        </button>

        <button
          className="nl-focus-btn"
          onClick={() => (isFocusMode ? exitFocus() : setIsFocusMode(true))}
          title={isFocusMode ? '退出图谱全屏 (F / ESC)' : '图谱全屏 (F)'}
        >
          {isFocusMode ? '⤢ 退出全屏' : '⤢ 图谱全屏'}
        </button>

        <div className="nl-topbar-avatar" title="小说剧本智能分析工作台 · 你的工作台">分</div>
      </header>

      {/* ---- 左侧窄导航（图标 + 文字）---- */}
      <nav className="nl-rail">
        {[
          { id: 'project', icon: Icons.project, label: '项目' },
          { id: 'graph', icon: Icons.graph, label: '图谱' },
          { id: 'timeline', icon: Icons.timeline, label: '演化' },
          { id: 'task', icon: Icons.task, label: '任务' },
          { id: 'model', icon: Icons.model, label: '模型' },
          { id: 'config', icon: Icons.config, label: '配置' },
          { id: 'about', icon: Icons.info, label: '关于' },
        ].map(item => (
          <button
            key={item.id}
            className={`nl-rail-btn ${activeRail === item.id ? 'active' : ''}`}
            onClick={() => {
              setActiveRail(item.id);
              if (item.id === 'task') {
                if (isFocusMode) exitFocus();
                setShowProjectDrawer(false);
                setShowTimelineDrawer(false);
                setShowTaskDrawer(v => !v);
              }
              else if (item.id === 'model') { setShowLLMManager(true); }
              else if (item.id === 'config') { setShowConfig(true); }
              else if (item.id === 'about') {
                if (isFocusMode) exitFocus();
                setShowProjectDrawer(false);
                setShowTimelineDrawer(false);
                setShowTaskDrawer(false);
                setShowAbout(true);
              }
              else if (item.id === 'timeline') {
                setShowProjectDrawer(false);
                setShowTaskDrawer(false);
                setShowTimelineDrawer(v => !v);
              }
              else if (item.id === 'project') {
                setShowTimelineDrawer(false);
                setShowTaskDrawer(false);
                setShowProjectDrawer(v => !v);
              }
              else if (item.id === 'graph') { setActiveRail('graph'); }
              // 项目导航保持高亮
            }}
            title={item.label}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.id === 'task' && activeTaskCount > 0 && (
              <span className="nl-rail-badge">{activeTaskCount}</span>
            )}
          </button>
        ))}
      </nav>

      {/* ---- 项目库 + 文本分析 左侧抽屉 ---- */}
      {showProjectDrawer && (
        <div className="nl-left-drawer-overlay" onClick={() => setShowProjectDrawer(false)}>
          <aside className="nl-left-drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="项目库与文本分析">
            <div className="nl-left-drawer-header">
              <h3>📁 项目库 · 文本分析</h3>
              <button className="nl-left-drawer-close" onClick={() => setShowProjectDrawer(false)} aria-label="关闭项目库">×</button>
            </div>
            <div className="nl-left-drawer-body">
              <aside className="nl-sidebar">
        {/* 项目库 */}
        <section className="nl-sb-section">
          <header className="nl-sb-h">
            <h3>项目库</h3>
            <span className="nl-sb-meta">
              {projectSearch
                ? <>筛选 {filteredProjects.length} / 共 {s.projects.length}</>
                : <>共 {s.projects.length}</>}
            </span>
          </header>

          <div className="nl-search">
            {Icons.search}
            <input
              placeholder="搜索项目名或 id…"
              value={projectSearch}
              onChange={e => setProjectSearch(e.target.value)}
            />
            {projectSearch && (
              <button className="nl-search-clear" onClick={() => setProjectSearch('')} aria-label="清除">×</button>
            )}
          </div>

          <div className="nl-sb-new">
            <input
              placeholder="新建项目名…"
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
            />
            <button className="nl-pill primary" onClick={handleCreateProject} title="新建项目">+ 新建</button>
          </div>

          {s.projectError && (
            <div className="nl-toast-error">
              项目列表加载失败：{s.projectError}
              <button className="nl-pill" onClick={() => s.fetchProjects()}>重试</button>
            </div>
          )}

          <div className="nl-proj-list">
            {filteredProjects.map(p => (
              <div
                key={p.id}
                className={`nl-proj ${s.currentProjectId === p.id ? 'selected' : ''}`}
                onClick={() => s.selectProject(p.id)}
              >
                {editingProjectId === p.id ? (
                  <div className="nl-proj-edit">
                    <input
                      value={editingName}
                      onChange={e => setEditingName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { s.renameProject(p.id, editingName); setEditingProjectId(null); }
                        if (e.key === 'Escape') setEditingProjectId(null);
                      }}
                      autoFocus
                    />
                    <button className="nl-pill" onClick={() => { s.renameProject(p.id, editingName); setEditingProjectId(null); }}>✓</button>
                  </div>
                ) : (
                  <>
                    <div className="nl-proj-row1">
                      <div
                        className="nl-proj-name"
                        dangerouslySetInnerHTML={{ __html: renderHighlighted(p.name) }}
                      />
                      <span className="nl-proj-id" dangerouslySetInnerHTML={{ __html: "#" + renderHighlighted(p.id) }} />
                    </div>
                    <div className="nl-proj-row2">
                      <span className="nl-proj-dot" />
                      <span>{p.nodeCount ?? 0} 人物 · {p.edgeCount ?? 0} 关系</span>
                      {p.lastUpdateAt && (
                        <span className="nl-proj-time" title={new Date(p.lastUpdateAt).toLocaleString()}>{formatRelativeTime(p.lastUpdateAt)}</span>
                      )}
                      <button
                        className="nl-proj-action"
                        onClick={(e) => { e.stopPropagation(); setEditingProjectId(p.id); setEditingName(p.name); }}
                        title="重命名"
                      >改</button>
                      <button
                        className="nl-proj-action danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`确定删除「${p.name}」？`)) s.deleteProject(p.id);
                        }}
                        title="删除"
                      >删</button>
                    </div>
                  </>
                )}
              </div>
            ))}
            {filteredProjects.length === 0 && !s.projectError && (
              <div className="nl-empty-hint">
                {projectSearch ? `找不到匹配「${projectSearch}」的项目` : '暂无项目，先在下方新建'}
              </div>
            )}
          </div>
        </section>

        {/* 文本分析 */}
        <section className="nl-sb-section nl-sb-section-flex">
          <header className="nl-sb-h">
            <h3>文本分析</h3>
            <span className="nl-sb-meta">本项目</span>
          </header>

          <div className="nl-refine">
            <div className="nl-ref-cell">
              <label>切片大小</label>
              <input
                type="number" min={100} step={50}
                value={chunkSize}
                onChange={e => setChunkSize(Math.max(100, parseInt(e.target.value) || 500))}
              />
              <span className="nl-ref-unit">字</span>
            </div>

            <div className="nl-ref-cell">
              <label>并发路数</label>
              <input
                type="number" min={1} max={8}
                value={concurrency}
                onChange={e => setConcurrency(Math.max(1, Math.min(8, parseInt(e.target.value) || 1)))}
              />
              <span className="nl-ref-unit">路</span>
            </div>

            <div className="nl-ref-cell nl-ref-wide">
              <label>模型配置</label>
              <select
                value={s.currentLlmId || ''}
                onChange={e => s.selectLlmModel(e.target.value)}
              >
                <option value="">选择模型…</option>
                {s.llmModels.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>

            <div className="nl-ref-cell nl-ref-wide">
              <label>分析范围</label>
              <select>
                <option>{chapterOptions.length > 0
                  ? `全部章节（第 1 — ${chapterOptions.length} 章）`
                  : '当前项目全文'}</option>
              </select>
            </div>
          </div>

          {/* 调试 + 章节范围（沿用既有功能） */}
          <div className="nl-ref-extras">
            <label className="nl-ref-checkbox">
              <input
                type="checkbox"
                checked={debug}
                onChange={e => setDebug(e.target.checked)}
              />
              <span>调试日志</span>
            </label>

            {chapterOptions.length > 0 && (
              <div className="nl-ref-cell nl-ref-wide" style={{ marginTop: 8 }}>
                <label>文本章节</label>
                <div className="nl-ref-chapter-range">
                  <select
                    className="nl-select"
                    value={s.chapterFrom || ''}
                    onChange={e => s.setChapterRange(parseInt(e.target.value, 10) || 0, s.chapterTo)}
                  >
                    <option value="">起始</option>
                    {chapterOptions.map((ch, i) => (
                      <option key={i} value={i + 1}>{ch}</option>
                    ))}
                  </select>
                  <span className="nl-range-sep">→</span>
                  <select
                    className="nl-select"
                    value={s.chapterTo || ''}
                    onChange={e => s.setChapterRange(s.chapterFrom, parseInt(e.target.value, 10) || 0)}
                  >
                    <option value="">终止</option>
                    {chapterOptions.map((ch, i) => (
                      <option key={i} value={i + 1}>{ch}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* v26.1：导入大文本只显示 meta 摘要；textarea 仅在粘贴小文本时显示 */}
          {s.textMeta && (
            <div className="nl-ref-text-stats" title={s.textMeta.fileName || ''}>
              已导入 {s.textMeta.chars.toLocaleString()} 字（{s.textMeta.encoding}）
              {s.textMeta.source === 'upload' && <span className="nl-ref-text-stats-tag"> 后端存储</span>}
              {s.textMeta.source === 'paste' && <span className="nl-ref-text-stats-tag"> 粘贴</span>}
              {chapterOptions.length > 0 && ` · ${chapterOptions.length} 章`}
            </div>
          )}
          {(!s.textMeta || s.textMeta.source === 'paste') && (
            <textarea
              placeholder={s.textMeta ? '粘贴文本将覆盖当前内容' : '或直接粘贴文本…'}
              value={s.pastedText}
              onChange={e => s.setPastedText(e.target.value)}
              className="nl-ref-textarea"
              disabled={!s.currentProjectId}
            />
          )}

          <div className="nl-ref-actions">
            {/* v2.5：label 包 file input 兼容所有浏览器（Edge/旧 Safari 下
                display:none 的 input 调 .click() 会被拦截）。点击 label = 点击 input。 */}
            <label
              className="secondary-button text-file-import-control"
              title={s.currentProjectId ? '导入文本' : '请先选择项目'}
            >
              导入文本
              <input
                ref={drawerTextFileRef}
                type="file"
                accept=".txt"
                onChange={handleTextFile}
                className="text-file-input-native"
                disabled={!s.currentProjectId}
              />
            </label>
            <button
              className="nl-btn outline"
              onClick={handleExportProject}
              disabled={!s.currentProjectId}
              title="导出项目"
            >
              导出项目
            </button>
            <button
              className="nl-btn accent"
              onClick={handleAnalyze}
              disabled={s.isAnalyzing || (!(s.pastedText || '').trim() && !s.textMeta) || !s.currentProjectId || !s.currentLlmId}
              title="运行分析"
            >
              {s.isAnalyzing ? `分析中… ${s.progress}%` : '运行分析'}
            </button>
          </div>

          {/* 进度 / 失败 / 引导（保留全部） */}
          {s.isAnalyzing && (
            <div className="nl-ref-progress">
              <div className="nl-progress-bar">
                <div className="nl-progress-bar-fill" style={{ width: `${s.progress}%` }} />
              </div>
              <div className="nl-ref-progress-meta">
                <span>成功 {s.runStats.successCount} / 失败 {s.runStats.failedCount} / 总 {s.runStats.totalChunks}</span>
                <button className="nl-pill" onClick={s.isPaused ? s.resumeAnalysis : s.pauseAnalysis}>
                  {s.isPaused ? '▶ 继续' : '⏸ 暂停'}
                </button>
              </div>
              {s.activeProgress?.degraded && (
                <div className="nl-ref-degraded">
                  ⚠ 已自动从 {s.activeProgress.rateLimitCount} 路降到 1 路
                </div>
              )}
            </div>
          )}

          {s.lastFailure && !s.isAnalyzing && (
            <div className="nl-ref-failure">
              上次失败 {s.lastFailure.chunks.length} 片
              <button className="nl-pill" onClick={() => s.retryFailedChunks(chunkSize, concurrency)}>重试</button>
              <button className="nl-pill" onClick={s.clearLastFailure}>忽略</button>
            </div>
          )}

          {!s.currentProjectId && !(s.pastedText || '').trim() && !s.textMeta && (
            <div className="nl-guide">
              {guideState.steps.map(step => (
                <div key={step.id} className={`nl-guide-step ${step.state}`}>
                  <span>{step.state === 'done' ? '✓' : step.state === 'current' ? '●' : '○'}</span>
                  <span>{step.title}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>
            </div>
          </aside>
        </div>
      )}

      {/* ---- 关系图谱主区 ---- */}
      <main className="nl-main">
        <header className="nl-main-h">
          <div className="nl-main-h-left">
            <h1>
              IP 关系全景
              {currentProject && <span className="nl-main-sub">· {currentProject.name}</span>}
              {!currentProject && <span className="nl-main-sub muted">· 未选择项目</span>}
            </h1>
            <div className="nl-main-subline">
              用于立项、审稿与改编分析 · 当前显示 {displayNodes.length} / {s.nodes.length} 人物 · {displayEdges.length} / {s.edges.length} 条关系
            </div>
          </div>
          <div className="nl-main-stats">
            <div className="nl-stat"><div className="nl-stat-v">{s.nodes.length}</div><div className="nl-stat-l">人物</div></div>
            <div className="nl-stat"><div className="nl-stat-v">{s.edges.length}</div><div className="nl-stat-l">关系</div></div>
            <div className="nl-stat"><div className="nl-stat-v">{graphChapterOptions.length}</div><div className="nl-stat-l">章节</div></div>
            <div className="nl-stat"><div className="nl-stat-v" style={{ color: 'var(--ok, #2f7a48)' }}>●</div><div className="nl-stat-l">{activeTaskCount > 0 ? `进行中 ${activeTaskCount}` : '空闲'}</div></div>
          </div>
        </header>

        {/* 工具栏：视图模式 + 缩略/完整 + 章节范围 + 边行数 */}
        <div className="nl-toolbar">
          <div className="nl-seg">
            {VIEW_MODES.map(m => {
              // v2.4：multi 档动态显示 "{X} 次起"，点击空白处切换 mode，点击下拉箭头打开 popover
              const isMulti = m.id === VIEW_MODE_IDS.MULTI;
              const label = isMulti && s.viewMode === m.id
                ? `${s.minAppearances} 次起`
                : m.label;
              return (
                <div key={m.id} className="nl-threshold-popover-anchor" style={{ position: 'relative', display: 'inline-flex' }}>
                  <button
                    className={s.viewMode === m.id ? 'active' : ''}
                    onClick={() => s.setViewMode(m.id)}
                  >{label}</button>
                  {isMulti && s.viewMode === m.id && (
                    <button
                      className="nl-threshold-toggle"
                      onClick={(e) => { e.stopPropagation(); setShowThresholdPopover(v => !v); }}
                      title="调整阈值"
                      aria-label="调整阈值"
                    >▾</button>
                  )}
                  {isMulti && showThresholdPopover && (
                    <div className="nl-threshold-popover" role="dialog" aria-label="阈值设置">
                      <label htmlFor="threshold-input">最少出现</label>
                      <input
                        id="threshold-input"
                        type="number"
                        min={2}
                        max={10}
                        step={1}
                        value={s.minAppearances}
                        onChange={(e) => s.setMinAppearances(e.target.value)}
                      />
                      <span>次</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="nl-seg">
            <button
              className={s.graphScope === 'preview' ? 'active' : ''}
              onClick={() => { s.setGraphScope('preview'); clearChapterRange(); }}
            >预览</button>
            <button
              className={s.graphScope === 'all' ? 'active' : ''}
              onClick={() => { s.setGraphScope('all'); clearChapterRange(); }}
            >全部</button>
          </div>

          {/* 章节范围（图谱专用） */}
          <div className="nl-range">
            <button
              className="nl-pill"
              onClick={() => setShowChapterPicker(v => !v)}
              disabled={graphChapterOptions.length === 0}
              title={graphChapterOptions.length === 0 ? '导入文本后自动检测章节' : '按章节过滤图谱'}
            >
              {chapterRangeLabel}
            </button>
            {showChapterPicker && graphChapterOptions.length > 0 && (
              <div className="nl-picker" ref={chapterPickerRef}>
                <input
                  className="nl-picker-search"
                  placeholder="搜章节号或名称"
                  value={chapterSearchTerm}
                  onChange={e => setChapterSearchTerm(e.target.value)}
                />
                <div className="nl-picker-cols">
                  <div className="nl-picker-col" ref={fromColRef}>
                    <div className="nl-picker-col-title">起始{chapterTerm}</div>
                    {filteredChapterOptions.length === 0 ? (
                <div className="nl-picker-empty">无匹配章节</div>
              ) : filteredChapterOptions.map((ch, i) => (
                      <div
                        key={`from-${i}`}
                        className={`nl-picker-item ${s.graphRange.from === graphChapterOptions.indexOf(ch) + 1 ? 'active' : ''}`}
                        onClick={() => handlePickChapterFromOption(graphChapterOptions.indexOf(ch))}
                      >{ch}</div>
                    ))}
                  </div>
                  <div className="nl-picker-col" ref={toColRef}>
                    <div className="nl-picker-col-title">终止{chapterTerm}</div>
                    {filteredChapterOptions.length === 0 ? (
                <div className="nl-picker-empty">无匹配章节</div>
              ) : filteredChapterOptions.map((ch, i) => (
                      <div
                        key={`to-${i}`}
                        className={`nl-picker-item ${s.graphRange.to === graphChapterOptions.indexOf(ch) + 1 ? 'active' : ''}`}
                        onClick={() => handlePickChapterToOption(graphChapterOptions.indexOf(ch))}
                      >{ch}</div>
                    ))}
                  </div>
                </div>
                <div className="nl-picker-foot">
                  <button className="nl-pill" onClick={clearChapterRange}>清除</button>
                </div>
              </div>
            )}
          </div>

          {/* 边标签行数 */}
          <div className="nl-lines">
            <span className="nl-lines-label">行</span>
            {[1, 2, 3, 5].map(n => (
              <button
                key={n}
                className={`nl-lines-btn ${s.edgeLabelLines === n ? 'active' : ''}`}
                onClick={() => s.setEdgeLabelLines(n)}
              >{n}</button>
            ))}
          </div>

          <div className="nl-legend">
            <span className="nl-legend-item"><span className="nl-legend-swatch" style={{ background: 'var(--accent, #b8323a)' }} />多次出现</span>
          </div>

          <div className="nl-toolbar-label">
            {coverData ? coverData.title : '布局就绪'}
          </div>

          <button className="nl-pill" onClick={() => document.documentElement.requestFullscreen?.()} title="全屏查看">
            {Icons.fullscreen}
          </button>
        </div>

        {/* 封面（如有） */}
        {coverData && s.nodes.length > 0 && (
          <div className="nl-cover">
            <div className="nl-cover-title">{coverData.title}</div>
            <div className="nl-cover-meta">
              {coverData.characterCount} 人物 · {coverData.relationshipCount} 关系
              {coverData.chapterCount > 0 && ` · ${coverData.chapterCount} 章`}
            </div>
            {coverData.hasSummary && <div className="nl-cover-summary">{coverData.summary}</div>}
          </div>
        )}

        {/* 图谱画布 */}
        <div className="nl-graph-wrap">
          <GraphView
            nodes={displayNodes}
            edges={displayEdges}
            edgeLabelLines={s.edgeLabelLines}
            onSelectNode={s.setSelectedNodeId}
          />
          <div className="nl-corner tl">力导向 · 当前 {displayEdges.length} / {s.edges.length}</div>
          <div className="nl-corner tr">
            {selectedProfile ? `已选 · ${selectedProfile.label}` : '未选择人物'}
          </div>
          <div className="nl-corner br">点击节点查看详情</div>
          <div className="nl-corner bl">图谱 · 放大 · 缩小 · 居中</div>
        </div>
      </main>

      {/* ---- 人物档案（右栏）---- */}
      <aside className="nl-inspector">
        <header className="nl-ins-h">
          <div className="nl-ins-eyebrow">人物档案</div>
          <h2>{selectedProfile ? selectedProfile.label : '尚未选择人物'}</h2>
        </header>

        {selectedProfile && (
          <>
            <div className="nl-ins-stats">
              <div className="nl-ins-stat"><div className="nl-ins-v">{selectedProfile.totalRelationships ?? selectedProfile.relationships?.length ?? 0}</div><div className="nl-ins-l">关系数</div></div>
              <div className="nl-ins-stat"><div className="nl-ins-v">{selectedProfile.chapterCount ?? graphChapterOptions.length}</div><div className="nl-ins-l">出现章节</div></div>
              <div className="nl-ins-stat"><div className="nl-ins-v">{selectedProfile.keyEventCount ?? (selectedProfile.events?.length ?? 0)}</div><div className="nl-ins-l">关键事件</div></div>
            </div>

            <div className="nl-ins-body">
              <CharacterInspector profile={selectedProfile} nodes={s.nodes} edges={s.edges} />
              {characterInsight && (
                <div className="nl-ins-card">
                  <h4>AI 洞察</h4>
                  <p className="nl-ins-card-headline">{characterInsight.headline}</p>
                  {characterInsight.points.map(pt => (
                    <div key={pt.id} className="nl-ins-point">· {pt.text}</div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {!selectedProfile && (
          <div className="nl-ins-empty">
            <p>从图谱或轨迹中选择人物，查看人物档案与记录的关系证据。</p>
          </div>
        )}
      </aside>

      {/* ---- 关系演化 左侧抽屉 ---- */}
      {showTimelineDrawer && (
        <div className="nl-left-drawer-overlay" onClick={() => setShowTimelineDrawer(false)}>
          <aside className="nl-left-drawer nl-left-drawer-timeline" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="关系演化时间线">
            <div className="nl-left-drawer-header">
              <h3>🕒 关系演化时间线</h3>
              <button className="nl-left-drawer-close" onClick={() => setShowTimelineDrawer(false)} aria-label="关闭关系演化">×</button>
            </div>
            <div className="nl-left-drawer-body">
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
            </div>
          </aside>
        </div>
      )}

      {/* ---- 弹层：任务（左抽屉）/ LLM 管理（右抽屉）/ 配置（右抽屉） ---- */}
      {showTaskDrawer && (
        <div className="nl-left-drawer-overlay" onClick={() => setShowTaskDrawer(false)}>
          <aside
            className="nl-left-drawer nl-left-drawer-task"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="分析任务"
          >
            <div className="nl-left-drawer-header">
              <h3>
                📜 分析任务
                <span className="nl-left-drawer-counts">
                  {taskCounts.running > 0 && <span className="nl-count-pill nl-count-running">{taskCounts.running} 运行</span>}
                  {taskCounts.paused > 0 && <span className="nl-count-pill nl-count-paused">{taskCounts.paused} 暂停</span>}
                  {taskCounts.interrupted > 0 && <span className="nl-count-pill nl-count-interrupted">{taskCounts.interrupted} 待继续</span>}
                  {taskCounts.failed > 0 && <span className="nl-count-pill nl-count-failed">{taskCounts.failed} 失败</span>}
                </span>
              </h3>
              <button className="nl-left-drawer-close" onClick={() => setShowTaskDrawer(false)} aria-label="关闭任务">×</button>
            </div>
            <div className="nl-left-drawer-body nl-left-drawer-task-body">
              <TaskPanel guideState={guideState} onGuide={handleGuide} />
            </div>
          </aside>
        </div>
      )}
      {showAbout && (
        <div className="nl-about-overlay" onClick={() => setShowAbout(false)}>
          <section className="nl-about-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="关于小说剧本智能分析工作台">
            <div className="nl-about-head">
              <div className="nl-about-mark">衡</div>
              <div>
                <div className="nl-about-brand">小说剧本智能分析工作台</div>
                <div className="nl-about-subtitle">小说剧本智能分析工作台</div>
              </div>
              <button className="nl-about-close" onClick={() => setShowAbout(false)} aria-label="关闭关于">×</button>
            </div>
            <div className="nl-about-body">
              <p className="nl-about-lead">让每一次立项，都有原文依据。</p>
              <p>小说剧本智能分析工作台服务出版编辑、影视开发与版权评估团队，将长篇小说或剧本整理为人物关系、章节脉络与关系演化，帮助团队更快形成共同理解。</p>
              <div className="nl-about-grid">
                <div><span>产品版本</span><strong>v2.5</strong></div>
                <div><span>交付方式</span><strong>本地 / 私有部署</strong></div>
                <div><span>作者</span><strong>你们喜爱的老王</strong></div>
                <div><span>许可协议</span><strong>MIT License</strong></div>
              </div>
            </div>
            <div className="nl-about-foot">分析结果作为分析底稿，最终判断由专业人员完成。</div>
          </section>
        </div>
      )}
      {showLLMManager && (
        <LLMManager onClose={() => setShowLLMManager(false)} />
      )}
      {showConfig && (
        <div className="nl-config-overlay" onClick={() => setShowConfig(false)}>
          <div className="nl-config-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="工作台配置">
            <div className="nl-config-modal-header">
              <h3>工作台配置</h3>
              <button className="nl-config-modal-close" onClick={() => setShowConfig(false)} aria-label="关闭配置">×</button>
            </div>
            <div className="nl-config-modal-body">
              <div className="nl-config-section">
                <label className="nl-config-section-label">外观主题</label>
                <div className="nl-theme-grid">
                  {THEMES.map(t => (
                    <div
                      key={t.id}
                      className={`nl-theme-card ${s.theme === t.id ? 'selected' : ''}`}
                      onClick={() => s.setTheme(t.id)}
                    >
                      <div className="nl-theme-preview" style={{ background: `linear-gradient(135deg, ${t.bg}, ${t.accent}22)` }} />
                      <div className="nl-theme-name">{t.name}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="nl-config-section">
                <label className="nl-config-section-label">切片大小</label>
                <input type="number" value={chunkSize} onChange={e => setChunkSize(parseInt(e.target.value) || 500)} />
              </div>
              <div className="nl-config-section">
                <label className="nl-config-section-label">系统提示词</label>
                <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} />
              </div>
            </div>
            <div className="nl-config-modal-footer">
              <button className="nl-btn outline" onClick={() => setShowConfig(false)}>取消</button>
              <button
                className="nl-btn accent"
                onClick={() => {
                  s.setChunkSize(chunkSize);
                  s.setSystemPrompt(systemPrompt);
                  saveConfig({ ...loadConfig(), defaultChunkSize: chunkSize, systemPrompt, debug });
                  setShowConfig(false);
                  showToast('配置已保存');
                }}
              >保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Toast ---- */}
      {toast && <div className="nl-toast">{toast}</div>}

      {/* ---- focus 模式提示气泡（首次进入时自动显示 6 秒） ---- */}
      {isFocusMode && showFocusHint && (
        <div className="nl-focus-hint" role="status" aria-live="polite">
          <span className="nl-focus-hint-icon" aria-hidden="true">⤢</span>
          <span>图谱全屏中 · 按 <kbd>ESC</kbd> 或点击右上角 ⤢ 退出 · 下次启动不再默认</span>
        </div>
      )}
    </div>
  );
}
