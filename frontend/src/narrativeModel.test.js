import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCharacterProfile,
  buildRelationshipTracks,
  buildChapterInsight,
  filterByChapter,
  filterByChapterRange,
  filterByViewMode,
  getChapters,
  getOrphanedNodeIds,
  limitGraphPreview,
  resolveWorkspaceStatus,
} from './narrativeModel.js';

test('buildCharacterProfile summarizes both incoming and outgoing relationships without mutation', () => {
  const nodes = [
    { id: 1, label: '乔峰', sect: '丐帮' },
    { id: 2, label: '段誉', sect: '大理' },
    { id: 3, label: '虚竹', sect: '逍遥派' },
  ];
  const edges = [
    { source: 1, target: 2, label: '结义兄弟' },
    { source: 3, target: 1, relationship: '结义兄弟' },
    { source: 1, target: 99, label: '未知' },
  ];
  const originalNodes = structuredClone(nodes);
  const originalEdges = structuredClone(edges);

  assert.deepEqual(buildCharacterProfile(nodes, edges, 1), {
    id: '1',
    label: '乔峰',
    sect: '丐帮',
    chapter: '',
    degree: 2,
    neighbors: [
      { id: '2', label: '段誉', sect: '大理', chapter: '', relationship: '结义兄弟', occurrence: 1 },
      { id: '3', label: '虚竹', sect: '逍遥派', chapter: '', relationship: '结义兄弟', occurrence: 1 },
    ],
  });
  assert.deepEqual(nodes, originalNodes);
  assert.deepEqual(edges, originalEdges);
});

test('buildCharacterProfile returns null for absent or missing selections', () => {
  const nodes = [{ id: 1, label: '乔峰' }];

  assert.equal(buildCharacterProfile(nodes, [], null), null);
  assert.equal(buildCharacterProfile(nodes, [], 99), null);
});

test('buildRelationshipTracks filters dangling edges and creates unique stable tracks', () => {
  const nodes = [
    { id: 1, label: '乔峰', sect: '丐帮' },
    { id: '2', label: '段誉', sect: '大理' },
  ];
  const edges = [
    { source: 1, target: '2', label: '朋友', occurrence: 1 },
    { source: 1, target: '2', relationship: '朋友', occurrence: 2 },
    { source: 1, target: 3, label: '悬空边' },
  ];

  assert.deepEqual(buildRelationshipTracks(nodes, edges), [
    {
      key: '["1","2","朋友",0]',
      source: { id: '1', label: '乔峰', sect: '丐帮', chapter: '' },
      target: { id: '2', label: '段誉', sect: '大理', chapter: '' },
      label: '朋友',
      chapter: '',
      edgeOccurrence: 1,
    },
    {
      key: '["1","2","朋友",1]',
      source: { id: '1', label: '乔峰', sect: '丐帮', chapter: '' },
      target: { id: '2', label: '段誉', sect: '大理', chapter: '' },
      label: '朋友',
      chapter: '',
      edgeOccurrence: 2,
    },
  ]);
  assert.deepEqual(buildRelationshipTracks(), []);
  assert.deepEqual(buildRelationshipTracks([], []), []);
});

test('buildRelationshipTracks encodes delimiter-like ids and labels without collisions', () => {
  const nodes = [
    { id: 'a->b', label: '甲' },
    { id: 'c', label: '乙' },
    { id: 'a', label: '丙' },
    { id: 'b->c', label: '丁' },
  ];
  const tracks = buildRelationshipTracks(nodes, [
    { source: 'a->b', target: 'c', label: 'd:0' },
    { source: 'a', target: 'b->c', label: 'd:0' },
  ]);

  assert.deepEqual(tracks.map(({ key }) => key), [
    '["a->b","c","d:0",0]',
    '["a","b->c","d:0",0]',
  ]);
  assert.equal(new Set(tracks.map(({ key }) => key)).size, 2);
});

test('buildRelationshipTracks surfaces chapter and occurrence on every track', () => {
  const nodes = [
    { id: 'aq', label: '阿Q', chapter: '第一章' },
    { id: 'weizhanggui', label: '假洋鬼子' },
  ];
  const edges = [
    { source: 'aq', target: 'weizhanggui', label: '被打', chapter: '第一章', occurrence: 3 },
  ];

  const [track] = buildRelationshipTracks(nodes, edges);
  assert.equal(track.chapter, '第一章');
  assert.equal(track.edgeOccurrence, 3);
  assert.equal(track.source.chapter, '第一章');
});

test('getChapters preserves first-seen order and drops empty values', () => {
  const chapters = getChapters(
    [
      { chapter: '第一章' },
      { chapter: '序' },
      { chapter: '' },
      { chapter: '第二章' },
      { chapter: '第一章' },
    ],
    [{ chapter: '序' }, { chapter: '第三章' }],
  );

  assert.deepEqual(chapters, ['第一章', '序', '第二章', '第三章']);
});

test('filterByViewMode separates merged and unique occurrences without mutation', () => {
  const edges = [
    { id: 'a', source: 'a', target: 'b', occurrence: 1 },
    { id: 'b', source: 'a', target: 'b', occurrence: 3 },
    { id: 'c', source: 'c', target: 'd', occurrence: 2 },
  ];
  const all = filterByViewMode(edges, 'all');
  assert.equal(all.length, 3);
  assert.deepEqual(filterByViewMode(edges, 'merged').map((e) => e.id), ['b', 'c']);
  assert.deepEqual(filterByViewMode(edges, 'unique').map((e) => e.id), ['a']);
  // 输入未被修改
  assert.equal(edges.length, 3);
});

test('filterByChapter keeps only edges tagged with the chosen chapter', () => {
  const edges = [
    { source: 'a', target: 'b', chapter: '第一章' },
    { source: 'a', target: 'c', chapter: '第二章' },
    { source: 'b', target: 'c', chapter: '' },
  ];
  assert.equal(filterByChapter(edges, '第一章').length, 1);
  assert.equal(filterByChapter(edges, '').length, 1);
  assert.equal(filterByChapter(edges, null).length, 3);
});

test('getOrphanedNodeIds returns nodes no kept edge still references', () => {
  const nodes = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];
  const keptEdges = [{ source: 'a', target: 'b' }];
  assert.deepEqual(getOrphanedNodeIds(nodes, keptEdges), ['c']);
  assert.deepEqual(getOrphanedNodeIds(nodes, []), ['a', 'b', 'c']);
});

test('resolveWorkspaceStatus follows error, loading, project, empty, ready precedence', () => {
  assert.deepEqual(
    resolveWorkspaceStatus({ errorMessage: '加载失败', isLoading: true, projectId: 'p1', nodeCount: 2 }),
    { key: 'error', title: '加载失败', message: '加载失败' },
  );
  assert.deepEqual(
    resolveWorkspaceStatus({ isLoading: true, projectId: 'p1', nodeCount: 2 }),
    { key: 'loading', title: '正在加载', message: '正在加载项目数据…' },
  );
  assert.deepEqual(
    resolveWorkspaceStatus({ projectId: null, nodeCount: 2 }),
    { key: 'no-project', title: '未选择项目', message: '请先选择或创建一个项目。' },
  );
  assert.deepEqual(
    resolveWorkspaceStatus({ projectId: 'p1', nodeCount: 0 }),
    { key: 'empty', title: '暂无人物', message: '当前项目还没有可展示的人物。' },
  );
  assert.deepEqual(
    resolveWorkspaceStatus({ projectId: 'p1', nodeCount: 2 }),
    { key: 'ready', title: '已就绪', message: '已加载 2 个人物。' },
  );
});

// ==================== v16：检查器章节化 ====================

test('buildCharacterProfile exposes node chapter and neighbor occurrence + chapter', () => {
  const nodes = [
    { id: 'aq', label: '阿Q', sect: '未庄', chapter: '第一章 序' },
    { id: 'laotouzi', label: '老头子', chapter: '第一章 序' },
    { id: 'weizhanggui', label: '假洋鬼子', chapter: '第二章 优胜记略' },
  ];
  const edges = [
    { source: 'aq', target: 'laotouzi', label: '互骂', chapter: '第一章 序', occurrence: 2 },
    { source: 'aq', target: 'weizhanggui', label: '被打', chapter: '第二章 优胜记略', occurrence: 1 },
  ];

  const profile = buildCharacterProfile(nodes, edges, 'aq');
  assert.equal(profile.chapter, '第一章 序');
  assert.equal(profile.degree, 2);
  // 邻居带 chapter + occurrence
  const [n1, n2] = profile.neighbors;
  assert.equal(n1.chapter, '第一章 序');
  assert.equal(n1.occurrence, 2);
  assert.equal(n1.relationship, '互骂');
  assert.equal(n2.chapter, '第二章 优胜记略');
  assert.equal(n2.occurrence, 1);
});

test('buildCharacterProfile 邻居 occurrence 缺省时降级为 1', () => {
  const nodes = [
    { id: 'a', label: '甲', chapter: '序' },
    { id: 'b', label: '乙' },
  ];
  const edges = [
    // 旧数据 / 导入数据可能没 occurrence 字段——必须降级为 1，UI 才不会渲染 ×NaN
    { source: 'a', target: 'b', label: '朋友', chapter: '序' },
  ];
  const profile = buildCharacterProfile(nodes, edges, 'a');
  assert.equal(profile.neighbors[0].occurrence, 1);
});

test('buildChapterInsight 完整场景：节点有 chapter + 多邻居跨章节', () => {
  const profile = {
    id: 'aq', label: '阿Q', sect: '未庄', chapter: '第一章 序',
    degree: 3,
    neighbors: [
      { id: 'laotouzi', label: '老头子', chapter: '第一章 序', relationship: '互骂', occurrence: 2 },
      { id: 'weizhanggui', label: '假洋鬼子', chapter: '第二章 优胜记略', relationship: '被打', occurrence: 1 },
      { id: 'wulao', label: '吴妈', chapter: '第二章 优胜记略', relationship: '调戏', occurrence: 3 },
    ],
  };
  const insight = buildChapterInsight(profile);
  assert.match(insight.headline, /阿Q/);
  // 节点 chapter '第一章 序' + 邻居 '第二章 优胜记略' 去重后是 2 个章节
  assert.match(insight.headline, /2 个章节/);
  assert.match(insight.headline, /6 条关系痕迹/);

  const ids = insight.points.map((p) => p.id);
  assert.deepEqual(ids, ['first', 'span', 'repeat', 'rel']);

  const first = insight.points.find((p) => p.id === 'first');
  assert.match(first.text, /第一章 序/);

  const span = insight.points.find((p) => p.id === 'span');
  // 「活跃跨度」按出现顺序汇总——不应该用字典序，否则「第十章」<「第二章」会错位
  assert.match(span.text, /第一章 序.*第二章 优胜记略/);

  const repeat = insight.points.find((p) => p.id === 'repeat');
  // 第一章 序 2 次 + 第二章 优胜记略 4 次 → 第二章 top；filter 掉 1 次的"被打"
  assert.match(repeat.text, /第二章 优胜记略/);
  assert.match(repeat.text, /×4/);
  // 「被打」只出现 1 次，不应出现在「反复出现」列表里
  assert.doesNotMatch(repeat.text, /被打/);

  const rel = insight.points.find((p) => p.id === 'rel');
  assert.match(rel.text, /已记录 3 类关系/);
  // 「调戏」跨 1 章，按相同出现章节数降序时只列 1；稳定排序即可
  assert.match(rel.text, /调戏/);
});

test('buildChapterInsight 节点无 chapter、邻居也无 chapter 时降级', () => {
  const profile = {
    id: 'x', label: '神秘人物', sect: '', chapter: '',
    degree: 1,
    neighbors: [{ id: 'y', label: 'Y', chapter: '', relationship: '未知', occurrence: 1 }],
  };
  const insight = buildChapterInsight(profile);
  assert.match(insight.headline, /未标注章节/);
  const first = insight.points.find((p) => p.id === 'first');
  assert.match(first.text, /尚未标注/);
  const span = insight.points.find((p) => p.id === 'span');
  assert.match(span.text, /尚未标注任何章节/);
});

test('buildChapterInsight 单章节时跨度文案不显示范围连字符', () => {
  const profile = {
    id: 'a', label: '甲', chapter: '第一章',
    degree: 1,
    neighbors: [{ id: 'b', label: '乙', chapter: '第一章', relationship: '友', occurrence: 1 }],
  };
  const insight = buildChapterInsight(profile);
  const span = insight.points.find((p) => p.id === 'span');
  assert.match(span.text, /仅出现于「第一章」/);
  assert.doesNotMatch(span.text, /—/);
});

test('buildChapterInsight 章节顺序按数据出现顺序而非字典序', () => {
  const profile = {
    id: 'a', label: '甲', chapter: '第十章',
    degree: 2,
    neighbors: [
      { id: 'b', label: '乙', chapter: '第二章', relationship: '友', occurrence: 1 },
      { id: 'c', label: '丙', chapter: '第十章', relationship: '敌', occurrence: 1 },
    ],
  };
  const insight = buildChapterInsight(profile);
  const span = insight.points.find((p) => p.id === 'span');
  // 节点 chapter 在前，所以「第十章」是起点；邻居按出现顺序「第二章」「第十章」
  assert.match(span.text, /^活跃跨度：第十章 — 第二章/);
});

test('buildChapterInsight 接受 null / undefined profile 不抛错', () => {
  assert.deepEqual(buildChapterInsight(null), { headline: '暂无可分析的人物。', points: [] });
  assert.deepEqual(buildChapterInsight(undefined), { headline: '暂无可分析的人物。', points: [] });
});

// ==================== v23：关系图章节范围过滤 ====================
// ranges 是 detectChapterRanges 的真实形态：[{chapter:'第N章 X', start: 数字}, ...]
// 下标 + 1 = 1-based 序号，与 chapterSplitter / 炼化阶段的 from/to 完全对齐。
const v23Ranges = [
  { chapter: '第一章 山村', start: 0 },
  { chapter: '第二章 入门', start: 60 },
  { chapter: '第三章 试炼', start: 140 },
  { chapter: '第四章 出山', start: 230 },
];
const v23Edges = [
  { source: 'a', target: 'b', chapter: '第一章 山村', occurrence: 1 },
  { source: 'a', target: 'c', chapter: '第二章 入门', occurrence: 1 },
  { source: 'b', target: 'd', chapter: '第三章 试炼', occurrence: 1 },
  { source: 'c', target: 'd', chapter: '第四章 出山', occurrence: 1 },
  { source: 'a', target: 'e', chapter: '', occurrence: 1 },     // 未标注
  { source: 'a', target: 'f', chapter: '未知章节', occurrence: 1 }, // 文本里没匹配的章节名
];

test('filterByChapterRange: null / undefined range 原样保留', () => {
  const out = filterByChapterRange(v23Edges, null, v23Ranges);
  assert.equal(out.length, v23Edges.length);
  const out2 = filterByChapterRange(v23Edges, undefined, v23Ranges);
  assert.equal(out2.length, v23Edges.length);
});

test('filterByChapterRange: from / to 全 0 视为不限', () => {
  const out = filterByChapterRange(v23Edges, { from: 0, to: 0 }, v23Ranges);
  assert.equal(out.length, v23Edges.length);
});

test('filterByChapterRange: 只设 from（10）保留第二章起', () => {
  const out = filterByChapterRange(v23Edges, { from: 2, to: 0 }, v23Ranges);
  const chapters = out.map((e) => e.chapter);
  assert.ok(chapters.includes('第二章 入门'));
  assert.ok(chapters.includes('第三章 试炼'));
  assert.ok(chapters.includes('第四章 出山'));
  assert.ok(!chapters.includes('第一章 山村'));
  // 空 chapter 和未知章节在范围模式下都被排除
  assert.ok(!chapters.includes(''));
  assert.ok(!chapters.includes('未知章节'));
});

test('filterByChapterRange: 只设 to（10）保留到第三章止', () => {
  const out = filterByChapterRange(v23Edges, { from: 0, to: 3 }, v23Ranges);
  const chapters = out.map((e) => e.chapter);
  assert.ok(chapters.includes('第一章 山村'));
  assert.ok(chapters.includes('第二章 入门'));
  assert.ok(chapters.includes('第三章 试炼'));
  assert.ok(!chapters.includes('第四章 出山'));
});

test('filterByChapterRange: from / to 都设（第2—第3章）', () => {
  const out = filterByChapterRange(v23Edges, { from: 2, to: 3 }, v23Ranges);
  assert.equal(out.length, 2);
  const chapters = out.map((e) => e.chapter).sort();
  // 中文字符按 Unicode 码点排序：'三'(0x4E09) < '二'(0x4E8C)
  assert.deepEqual(chapters, ['第三章 试炼', '第二章 入门']);
});

test('filterByChapterRange: from > to 返回空（不抛错）', () => {
  const out = filterByChapterRange(v23Edges, { from: 3, to: 1 }, v23Ranges);
  assert.equal(out.length, 0);
});

test('filterByChapterRange: ranges 为空退化保留全部边（避免误清空图谱）', () => {
  const out = filterByChapterRange(v23Edges, { from: 2, to: 3 }, []);
  assert.equal(out.length, v23Edges.length);
});

test('filterByChapterRange: 输入为非数字字符串时按 0 处理（视为不限）', () => {
  const out = filterByChapterRange(v23Edges, { from: 'abc', to: '' }, v23Ranges);
  assert.equal(out.length, v23Edges.length);
});

test('filterByChapterRange: 原数组不被改写', () => {
  const before = v23Edges.slice();
  filterByChapterRange(v23Edges, { from: 2, to: 3 }, v23Ranges);
  assert.deepEqual(v23Edges, before);
});

// ==================== v26.2：图谱预览限量 ====================
test('limitGraphPreview: 默认只取前 5 章 + 未标注边，跳过第 6 章', () => {
  const edges = [
    ...v23Edges.filter((edge) => edge.chapter !== '未知章节'),
    { source: 'n5', target: 'n6', chapter: '第五章 新行', occurrence: 1 },
    { source: 'n6', target: 'n7', chapter: '第六章 新行', occurrence: 1 },
    { source: 'n7', target: 'n8', chapter: '未知章节', occurrence: 1 },
  ];
  const out = limitGraphPreview(edges);
  assert.equal(out.length, 6); // 前五章 5 条 + 未标注 1 条
  const chapters = out.map((e) => e.chapter);
  assert.ok(chapters.includes('第一章 山村'));
  assert.ok(chapters.includes('第二章 入门'));
  assert.ok(chapters.includes('第三章 试炼'));
  assert.ok(chapters.includes('第四章 出山'));
  assert.ok(chapters.includes('第五章 新行'));
  assert.ok(!chapters.includes('第六章 新行'));
  assert.ok(chapters.includes(''));
});

test('limitGraphPreview: maxNodes 截断（同章节边，每条 2 个新端点 → 5 条 = 10 节点）', () => {
  const edges = [];
  for (let i = 1; i <= 40; i++) edges.push({ source: `s${i}`, target: `t${i}`, chapter: '第1章', occurrence: 1 });
  const out = limitGraphPreview(edges, { maxNodes: 10, maxEdges: 100 });
  assert.equal(out.length, 5);
  const ids = new Set();
  for (const e of out) { ids.add(e.source); ids.add(e.target); }
  assert.ok(ids.size <= 10);
});

test('limitGraphPreview: maxEdges 截断', () => {
  const edges = Array.from({ length: 50 }, (_, i) => ({ source: i, target: i + 1000, chapter: '', occurrence: 1 }));
  const out = limitGraphPreview(edges, { maxEdges: 20, maxNodes: 9999 });
  assert.equal(out.length, 20);
});

test('limitGraphPreview: 无章节边全部放行直到上限', () => {
  const edges = Array.from({ length: 500 }, (_, i) => ({ source: i, target: i + 1000, chapter: '', occurrence: 1 }));
  const out = limitGraphPreview(edges, { maxNodes: 9999 });
  assert.equal(out.length, 300); // 默认 maxEdges=300
});

test('limitGraphPreview: 非法参数回默认（不抛错）', () => {
  const out = limitGraphPreview(v23Edges, { chapterLimit: 0, maxNodes: -1, maxEdges: 'x' });
  assert.equal(out.length, 6);
});

test('limitGraphPreview: 原数组不被改写', () => {
  const before = v23Edges.slice();
  limitGraphPreview(v23Edges);
  assert.deepEqual(v23Edges, before);
});
