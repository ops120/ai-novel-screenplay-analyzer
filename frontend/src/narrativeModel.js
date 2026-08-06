function normalizeId(value) {
  const id = value && typeof value === 'object' ? value.id : value;
  return id === null || id === undefined ? null : String(id);
}

function summarizeNode(node) {
  return {
    id: String(node.id),
    label: node.label ?? '',
    sect: node.sect ?? '',
    chapter: node.chapter ?? '',
  };
}

function relationshipLabel(edge) {
  return edge.relationship ?? edge.label ?? '';
}

function edgeChapter(edge) {
  return typeof edge.chapter === 'string' ? edge.chapter : '';
}

function edgeOccurrence(edge) {
  const raw = edge.occurrence;
  const value = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function buildCharacterProfile(nodes = [], edges = [], selectedId) {
  const normalizedSelectedId = normalizeId(selectedId);
  if (normalizedSelectedId === null) return null;

  const nodeById = new Map(
    nodes.map((node) => [normalizeId(node.id), node]),
  );
  const selectedNode = nodeById.get(normalizedSelectedId);
  if (!selectedNode) return null;

  const neighbors = [];
  for (const edge of edges) {
    const sourceId = normalizeId(edge.source);
    const targetId = normalizeId(edge.target);
    let neighborId = null;

    if (sourceId === normalizedSelectedId) neighborId = targetId;
    else if (targetId === normalizedSelectedId) neighborId = sourceId;

    const neighbor = nodeById.get(neighborId);
    if (neighbor) {
      // v16：把边的 chapter / occurrence 也透给邻居，UI 层做章节化展示。
      // 缺省时 chapter → ''（与节点同语义），occurrence → 1（与全局边契约一致）。
      neighbors.push({
        ...summarizeNode(neighbor),
        relationship: relationshipLabel(edge),
        chapter: edgeChapter(edge),
        occurrence: edgeOccurrence(edge),
      });
    }
  }

  return {
    ...summarizeNode(selectedNode),
    degree: neighbors.length,
    neighbors,
  };
}

export function buildRelationshipTracks(nodes = [], edges = []) {
  const nodeById = new Map(
    nodes.map((node) => [normalizeId(node.id), node]),
  );
  const occurrenceBySignature = new Map();
  const tracks = [];

  for (const edge of edges) {
    const sourceId = normalizeId(edge.source);
    const targetId = normalizeId(edge.target);
    const source = nodeById.get(sourceId);
    const target = nodeById.get(targetId);
    if (!source || !target) continue;

    const label = relationshipLabel(edge);
    const signature = JSON.stringify([sourceId, targetId, label]);
    const occurrence = occurrenceBySignature.get(signature) ?? 0;
    occurrenceBySignature.set(signature, occurrence + 1);
    tracks.push({
      key: JSON.stringify([sourceId, targetId, label, occurrence]),
      source: summarizeNode(source),
      target: summarizeNode(target),
      label,
      chapter: edgeChapter(edge),
      edgeOccurrence: edgeOccurrence(edge),
    });
  }

  return tracks;
}

// v15：返回按出现顺序去重后的章节名列表，过滤掉空字符串；保证「无章节」不会污染下拉。
export function getChapters(edges = [], nodes = []) {
  const seen = new Set();
  const ordered = [];
  const collect = (raw) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  for (const edge of edges) collect(edge.chapter);
  for (const node of nodes) collect(node.chapter);
  return ordered;
}

// v15：视图模式过滤。
// - 'all'    保留全部边
// - 'merged' 仅保留 occurrence > 1 的边（多次出现）
// - 'unique' 仅保留 occurrence === 1 的边（仅出现一次）
export function filterByViewMode(edges = [], mode = 'all', min = 2) {
  // v2.5：兼容两套 mode id — 'merged'（旧）和 'multi'（App.jsx / store 现在用的）
  const mergedMode = mode === 'merged' || mode === 'multi';
  if (mergedMode) {
    const threshold = Math.max(2, Math.min(10, Math.floor(Number(min) || 2)));
    return edges.filter((edge) => edgeOccurrence(edge) >= threshold);
  }
  if (mode === 'unique' || mode === 'single') {
    return edges.filter((edge) => edgeOccurrence(edge) === 1);
  }
  return edges.slice();
}

// v26.2：图谱「预览」限量 —— 默认只取前 N 个章节 + 节点/边上限，避免全量加载卡顿。
// 顺序：按边出现顺序收集前 chapterLimit 个不同章节（未标注章节的边不受章节数限制，始终参与），
// 再按节点数 / 边数上限截断；返回截断后的边数组。参数均做兜底，非法值回默认。
export function limitGraphPreview(edges = [], { chapterLimit = 5, maxNodes = 150, maxEdges = 300 } = {}) {
  if (!Number.isFinite(chapterLimit) || chapterLimit <= 0) chapterLimit = 5;
  if (!Number.isFinite(maxNodes) || maxNodes <= 0) maxNodes = 150;
  if (!Number.isFinite(maxEdges) || maxEdges <= 0) maxEdges = 300;
  const seenChapters = new Set();
  const kept = [];
  const nodeIds = new Set();
  for (const edge of edges) {
    const ch = edgeChapter(edge);
    if (ch && !seenChapters.has(ch)) {
      if (seenChapters.size >= chapterLimit) continue; // 前 N 章之外的边跳过
      seenChapters.add(ch);
    }
    if (edge.source !== null && edge.source !== undefined) nodeIds.add(String(edge.source));
    if (edge.target !== null && edge.target !== undefined) nodeIds.add(String(edge.target));
    if (nodeIds.size > maxNodes) break;
    kept.push(edge);
    if (kept.length >= maxEdges) break;
  }
  return kept;
}

// v15：按章节过滤边；当 chapter 为 null/undefined 时返回原数组不变。
// 空字符串视为「未标注章节」，与已命名章节分桶，需要下拉里单独保留「未标注」项。
export function filterByChapter(edges = [], chapter) {
  if (chapter === null || chapter === undefined) return edges.slice();
  return edges.filter((edge) => edgeChapter(edge) === chapter);
}

// v23：按章节序号范围过滤边。
// - range = { from, to } 中 from / to 为 1-based 章节序号（来自 detectChapterRanges 下标+1）。
// - 0 / NaN / undefined 视为该端不限。
// - ranges 来自 detectChapterRanges(text)；给定了真实的「章节字符串 → 序号」映射，
//   否则空章节字符串无法定位序号 → 退化为保留全部边（与 filterByChapter null 同语义）。
// - 空字符串 chapter 视为「未标注章节」，范围模式下不计入 from/to，仅在没设范围时出现。
export function filterByChapterRange(edges = [], range, ranges = []) {
  if (!range || typeof range !== 'object') return edges.slice();
  const fromRaw = Number(range.from);
  const toRaw = Number(range.to);
  const from = Number.isFinite(fromRaw) && fromRaw >= 1 ? Math.floor(fromRaw) : 0;
  const to = Number.isFinite(toRaw) && toRaw >= 1 ? Math.floor(toRaw) : 0;
  if (!from && !to) return edges.slice();
  if (!Array.isArray(ranges) || ranges.length === 0) {
    // 没有可用的章节映射 → 退化：保留全部（避免把图谱清空引起用户误解）。
    return edges.slice();
  }
  const chapterToIndex = new Map();
  ranges.forEach((r, i) => {
    if (r && typeof r.chapter === 'string' && !chapterToIndex.has(r.chapter)) {
      chapterToIndex.set(r.chapter, i + 1);  // 1-based
    }
  });
  return edges.filter((edge) => {
    const ch = edgeChapter(edge);
    if (!ch) return false;  // 未标注章节在范围模式下不显示（区别于「全部章节」下的保留）
    const idx = chapterToIndex.get(ch);
    if (!idx) return false;  // 文本里没匹配上的章节名也排除
    if (from && idx < from) return false;
    if (to && idx > to) return false;
    return true;
  });
}

// v15：过滤后的图谱可能存在「孤立节点」（没有任何匹配章节/视图模式的边）。
// 列出仍被边引用、但被过滤掉的节点 id，便于 UI 高亮提示。
export function getOrphanedNodeIds(nodes = [], keptEdges = []) {
  const referenced = new Set();
  for (const edge of keptEdges) {
    const s = normalizeId(edge.source);
    const t = normalizeId(edge.target);
    if (s) referenced.add(s);
    if (t) referenced.add(t);
  }
  const orphans = [];
  for (const node of nodes) {
    const id = normalizeId(node.id);
    if (id && !referenced.has(id)) orphans.push(id);
  }
  return orphans;
}

// v16：基于 profile 生成「AI 洞察」要点列表，纯聚合、零网络。
// 不调 LLM——LLM 摘要放在独立 LLMManager 流程里，本函数只服务 UI 层的即时展示。
// 返回对象：{ headline: string, points: [{ id, text }] }。
// headline 描述人物整体的章节活跃度；points 是 4 条要点（数量固定，便于 UI 占位）。
export function buildChapterInsight(profile) {
  if (!profile) {
    return { headline: '暂无可分析的人物。', points: [] };
  }
  const label = profile.label || '该人物';
  const nodeChapter = typeof profile.chapter === 'string' ? profile.chapter.trim() : '';
  const neighbors = Array.isArray(profile.neighbors) ? profile.neighbors : [];

  // 把邻居按章节分桶，同时累加 occurrence。
  // 同一章节可能有多条不同关系 → chapterEdges[ch] 是 Set<relationship>。
  const chapterOccurrence = new Map(); // chapter -> total occurrence
  const chapterEdges = new Map();      // chapter -> Set<relationship>
  const allRelationships = new Set();
  let totalOccurrence = 0;
  let anyChapter = false;

  for (const n of neighbors) {
    const ch = (typeof n.chapter === 'string' ? n.chapter.trim() : '') || '未标注章节';
    if (n.chapter && n.chapter.trim()) anyChapter = true;
    const occ = Number.isFinite(n.occurrence) && n.occurrence > 0 ? n.occurrence : 1;
    chapterOccurrence.set(ch, (chapterOccurrence.get(ch) || 0) + occ);
    totalOccurrence += occ;
    if (!chapterEdges.has(ch)) chapterEdges.set(ch, new Set());
    if (n.relationship) {
      chapterEdges.get(ch).add(n.relationship);
      allRelationships.add(n.relationship);
    }
  }

  // 要点 1：首次登场（节点 chapter 优先；缺失时降级到邻居的最早章节）。
  // 「最早」按数据出现顺序——narrativeModel 不依赖字符串字典序，避免「第十章」<「第二章」的坑。
  let firstChapter = nodeChapter;
  if (!firstChapter) {
    for (const n of neighbors) {
      if (n.chapter && n.chapter.trim()) { firstChapter = n.chapter.trim(); break; }
    }
  }
  const firstChapterPoint = firstChapter
    ? `首次登场于「${firstChapter}」。`
    : '首次登场章节尚未标注。';

  // 要点 2：活跃跨度——汇总所有出现过的章节（节点 + 邻居）去重按出现顺序。
  const spanSeen = new Set();
  const spanOrdered = [];
  const pushSpan = (raw) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed || spanSeen.has(trimmed)) return;
    spanSeen.add(trimmed);
    spanOrdered.push(trimmed);
  };
  pushSpan(nodeChapter);
  for (const n of neighbors) pushSpan(n.chapter);
  let spanPoint;
  if (spanOrdered.length === 0) {
    spanPoint = '活跃跨度：尚未标注任何章节。';
  } else if (spanOrdered.length === 1) {
    spanPoint = `活跃跨度：仅出现于「${spanOrdered[0]}」。`;
  } else {
    spanPoint = `活跃跨度：${spanOrdered[0]} — ${spanOrdered[spanOrdered.length - 1]}（共 ${spanOrdered.length} 个章节）。`;
  }

  // 要点 3：反复出现的章节——按 occurrence 总数降序，过滤掉 1 次的，只列 top。
  const repeated = [...chapterOccurrence.entries()]
    .filter(([ch, occ]) => occ > 1 && ch !== '未标注章节')
    .sort((a, b) => b[1] - a[1]);
  let repeatPoint;
  if (repeated.length === 0) {
    repeatPoint = '反复出现的章节：暂无（每条关系仅出现一次）。';
  } else {
    const top = repeated.slice(0, 3)
      .map(([ch, occ]) => `「${ch}」（×${occ}）`)
      .join('、');
    const more = repeated.length > 3 ? ` 等 ${repeated.length} 章` : '';
    repeatPoint = `反复出现的章节：${top}${more}。`;
  }

  // 要点 4：关系类型分布——按出现章节数降序，相同出现章节数按字典序稳定。
  const relationshipByChapterCount = [...allRelationships]
    .map((rel) => {
      let count = 0;
      for (const set of chapterEdges.values()) if (set.has(rel)) count++;
      return { rel, count };
    })
    .sort((a, b) => (b.count - a.count) || a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
  let relPoint;
  if (relationshipByChapterCount.length === 0) {
    relPoint = '已记录的关系类型：未标注。';
  } else {
    const list = relationshipByChapterCount.slice(0, 5)
      .map(({ rel, count }) => count > 1 ? `${rel}（跨 ${count} 章）` : rel)
      .join('、');
    const more = relationshipByChapterCount.length > 5
      ? ` 等 ${relationshipByChapterCount.length} 种`
      : '';
    relPoint = `已记录 ${relationshipByChapterCount.length} 类关系：${list}${more}。`;
  }

  // headline：用人物名 + 章节活跃度一句话总结，给用户第一眼就抓到信息密度。
  const headline = anyChapter || nodeChapter
    ? `${label} 出现在 ${spanOrdered.length || 1} 个章节，累计 ${totalOccurrence} 条关系痕迹。`
    : `${label} 的图谱关系暂未标注章节。`;

  return {
    headline,
    points: [
      { id: 'first', text: firstChapterPoint },
      { id: 'span', text: spanPoint },
      { id: 'repeat', text: repeatPoint },
      { id: 'rel', text: relPoint },
    ],
  };
}

export function resolveWorkspaceStatus({
  projectId,
  isLoading = false,
  errorMessage = '',
  nodeCount = 0,
} = {}) {
  if (errorMessage) {
    return { key: 'error', title: '加载失败', message: errorMessage };
  }
  if (isLoading) {
    return { key: 'loading', title: '正在加载', message: '正在加载项目数据…' };
  }
  if (projectId === null || projectId === undefined || projectId === '') {
    return { key: 'no-project', title: '未选择项目', message: '请先选择或创建一个项目。' };
  }
  if (nodeCount <= 0) {
    return { key: 'empty', title: '暂无人物', message: '当前项目还没有可展示的人物。' };
  }
  return { key: 'ready', title: '已就绪', message: `已加载 ${nodeCount} 个人物。` };
}
