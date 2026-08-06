// v26：商业化「叙图」叙事封面 / 人物洞察 纯函数模块。
// 全部纯函数：零网络、零 React，便于 store / view 层任意复用。
// 不引入新的存储 / schema；只解读既有项目 / nodes / edges / 章节边界。

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    return value.id === null || value.id === undefined ? null : String(value.id);
  }
  return String(value);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ============================================================
// buildNarrativeCover
// ------------------------------------------------------------
// 输入：项目（含 description / type）+ nodes + edges + 章节范围（来自 detectChapterRanges）+ 炼化进度
// 输出：UI 直接消费的 cover 对象。
//   { title, type, summary, hasSummary, characterCount, relationshipCount,
//     chapterCount, completionPercent, completionFraction: {completed,total} }
//
// 严禁：
// - 无 description 自动编造简介（spec §5.3）。
// - 无 totalChunks 时假装 100%。
// ============================================================
export function buildNarrativeCover({
  project = null,
  nodes = [],
  edges = [],
  chapters = [],
  completedChunks = 0,
  totalChunks = 0,
} = {}) {
  if (!project) return null;

  const name = trimString(project.name) || '未命名项目';
  const type = trimString(project.type) || '待补充';
  const description = trimString(project.description);
  const hasSummary = description.length > 0;

  const characterCount = Array.isArray(nodes) ? nodes.length : 0;
  const relationshipCount = Array.isArray(edges) ? edges.length : 0;
  const chapterCount = Array.isArray(chapters) ? chapters.length : 0;

  const safeTotal = Number.isFinite(totalChunks) && totalChunks >= 0
    ? Math.floor(totalChunks) : 0;
  const safeCompleted = Number.isFinite(completedChunks) && completedChunks >= 0
    ? Math.floor(completedChunks) : 0;
  const completionPercent = safeTotal > 0
    ? Math.min(100, Math.round((safeCompleted / safeTotal) * 100))
    : 0;

  return {
    title: name,
    type,
    summary: description,
    hasSummary,
    characterCount,
    relationshipCount,
    chapterCount,
    completionPercent,
    completionFraction: {
      completed: safeCompleted,
      total: safeTotal,
    },
  };
}

// ============================================================
// buildCharacterInsights
// ------------------------------------------------------------
// 输入：
//   profile: 由 buildCharacterProfile 产出的对象 { id, label, sect, chapter, neighbors[] }
//   edges: 同视图层使用的边集合（用于推导人物间关系变化）
//   chapters: 章节边界 [{chapter, start}]，可为空
// 输出：
//   {
//     id, label, summary,
//     directRelationCount,  // 不同邻居数（去重）
//     turningPointCount,    // 「同一对人物出现 ≥2 个不同关系」的去重转折数
//     corePercent,          // 0–100 整数：节点度数 / (总节点数-1)
//     keyChanges: [
//       { otherId, otherLabel, fromLabel, toLabel,
//         evidenceChapters: [chapter...], noEvidence }
//     ],
//   }
//
// 关键约束：
// - keyChanges 必须来自真实 edges；不允许 model 自动生成。
// - 没有真实章节依据时把 noEvidence = true，UI 文案写「暂无可追溯证据」。
// ============================================================
export function buildCharacterInsights(profile, edges = [], nodes = [], _chapters = []) {
  if (!profile) return null;
  const id = normalizeId(profile.id);
  if (!id) return null;

  // summary：用现有字段拼一行短句；空字段直接省略。
  const summaryParts = [];
  if (profile.label) summaryParts.push(profile.label);
  if (profile.sect) summaryParts.push(profile.sect);
  if (profile.chapter && trimString(profile.chapter)) summaryParts.push(`登场 ${trimString(profile.chapter)}`);
  const summary = summaryParts.join(' · ');

  // label lookup（允许上层补 nodes；缺省时用 id 占位）
  const labelByNodeId = new Map();
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      const nid = normalizeId(n?.id);
      if (nid) labelByNodeId.set(nid, n.label || n.name || nid);
    }
  }

  const profileEdges = Array.isArray(edges) ? edges : [];
  const neighborIds = new Set();
  // 仅保留与本人物相邻的边；与 nodes/edges 数据形态兼容。
  const adjacentEdges = [];
  for (const edge of profileEdges) {
    const sourceId = normalizeId(edge.source);
    const targetId = normalizeId(edge.target);
    if (sourceId === null || targetId === null) continue;
    if (sourceId === id) {
      neighborIds.add(targetId);
      adjacentEdges.push({ ...edge, otherId: targetId });
    } else if (targetId === id) {
      neighborIds.add(sourceId);
      adjacentEdges.push({ ...edge, otherId: sourceId });
    }
  }
  const directRelationCount = neighborIds.size;

  // 核心度：度数 / 当前视图的总节点数（包含自身），0–100 整数。
  // 没有邻居时计 0；除零保护：总节点数 >= 1 时按比例。
  const totalNodeIds = new Set();
  // 自身也计入总节点（让 a/b 的 1:1 图谱得到 50% 而非 100%）
  totalNodeIds.add(id);
  for (const edge of profileEdges) {
    const sourceId = normalizeId(edge.source);
    const targetId = normalizeId(edge.target);
    if (sourceId !== null) totalNodeIds.add(sourceId);
    if (targetId !== null) totalNodeIds.add(targetId);
  }
  const totalNodesInView = Math.max(totalNodeIds.size, 1);
  const corePercentRaw = totalNodesInView > 0
    ? Math.round((neighborIds.size / totalNodesInView) * 100)
    : 0;
  const corePercent = Math.max(0, Math.min(100, corePercentRaw));

  // keyChanges：同一对人物出现两个不同关系 → 1 次转折；按最早出现章节记录 evidence。
  // 若所有边 chapter 都为空 → 把这条转折标为 noEvidence，让 UI 显示「暂无可追溯证据」。
  const byOther = new Map(); // otherId -> [{ chapter, label, hasChapter }]
  for (const e of adjacentEdges) {
    const list = byOther.get(e.otherId) || [];
    list.push({
      label: trimString(e.relationship || e.label || '') || '未标注',
      chapter: trimString(e.chapter),
      hasChapter: trimString(e.chapter).length > 0,
    });
    byOther.set(e.otherId, list);
  }
  const keyChanges = [];
  let turningPointCount = 0;
  for (const [otherId, entries] of byOther.entries()) {
    const seenLabels = new Set();
    for (const ent of entries) seenLabels.add(ent.label);
    if (seenLabels.size < 2) continue;
    // 提取第一次和最后一次关系（按出现顺序）作为变化方向
    const first = entries[0];
    const last = entries[entries.length - 1];
    if (first.label === last.label) continue;
    const evidenceChapters = [];
    let hasAnyEvidence = false;
    for (const ent of entries) {
      if (ent.hasChapter && ent.chapter) {
        hasAnyEvidence = true;
        if (!evidenceChapters.includes(ent.chapter)) evidenceChapters.push(ent.chapter);
      }
    }
    keyChanges.push({
      otherId,
      otherLabel: labelByNodeId.get(otherId) || otherId,
      fromLabel: first.label,
      toLabel: last.label,
      evidenceChapters,
      noEvidence: !hasAnyEvidence,
    });
    turningPointCount += 1;
  }

  // 稳定排序：先按最早的 evidenceChapters[0]，再按 otherLabel code-point 序。
  // 不用 localeCompare / 中文 collation：环境差异会破坏快照测试。
  function cmp(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  keyChanges.sort((a, b) => {
    const aStart = a.evidenceChapters[0] || a.otherLabel;
    const bStart = b.evidenceChapters[0] || b.otherLabel;
    return cmp(aStart, bStart) || cmp(a.otherLabel, b.otherLabel);
  });

  return {
    id,
    label: profile.label || '',
    summary,
    directRelationCount,
    turningPointCount,
    corePercent,
    keyChanges,
    noEvidence: keyChanges.length === 0
      ? directRelationCount === 0
      : keyChanges.every((c) => c.noEvidence),
  };
}
