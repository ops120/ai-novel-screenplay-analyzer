// v26：商业化「叙图」叙事封面 / 人物洞察 数据模型（TDD）
// 项目叙事封面（图谱左上角白色浮层）+ 人物洞察（右侧面板）。
// 全部纯函数：零网络、零 React，便于在 store / view 层任意复用。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNarrativeCover,
  buildCharacterInsights,
} from './narrativeCover.js';

// ============================================================
// 叙事封面
// ============================================================

test('buildNarrativeCover: 返回项目名 + 题材 + 简介 + 统计 + 完整度', () => {
  const cover = buildNarrativeCover({
    project: { id: 7, name: '《长安旧事》', description: '长安城权力更迭前夜，一桩旧案将沈砚与顾昭重新卷入五大阵营。', type: '古装悬疑 · 长篇小说' },
    nodes: [
      { id: 'a' }, { id: 'b' }, { id: 'c' },
    ],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'a', target: 'c' },
    ],
    chapters: [
      { chapter: '第一章 序' },
      { chapter: '第二章 重启' },
      { chapter: '第三章 抉择' },
    ],
    completedChunks: 40,
    totalChunks: 50,
  });

  assert.equal(cover.title, '《长安旧事》');
  assert.equal(cover.type, '古装悬疑 · 长篇小说');
  assert.match(cover.summary, /长安城/);
  assert.equal(cover.characterCount, 3);
  assert.equal(cover.relationshipCount, 3);
  assert.equal(cover.chapterCount, 3);
  assert.equal(cover.completionPercent, 80);
  assert.equal(cover.hasSummary, true);
  assert.equal(cover.completionFraction.completed, 40);
  assert.equal(cover.completionFraction.total, 50);
});

test('buildNarrativeCover: 没有简介时 isEmpty=true、hasSummary=false、description=""', () => {
  const cover = buildNarrativeCover({
    project: { id: 1, name: '未命名卷宗', type: '影视改编评估' },
    nodes: [],
    edges: [],
    chapters: [],
    completedChunks: 0,
    totalChunks: 0,
  });

  assert.equal(cover.title, '未命名卷宗');
  assert.equal(cover.summary, '');
  assert.equal(cover.hasSummary, false);
  assert.equal(cover.characterCount, 0);
  assert.equal(cover.relationshipCount, 0);
  assert.equal(cover.chapterCount, 0);
  assert.equal(cover.completionPercent, 0);
});

test('buildNarrativeCover: 无 project 时返回 null', () => {
  assert.equal(buildNarrativeCover({
    project: null,
    nodes: [],
    edges: [],
    chapters: [],
  }), null);
});

test('buildNarrativeCover: 简介为空字符串视同无简介（不自动编造）', () => {
  const cover = buildNarrativeCover({
    project: { id: 1, name: 'X', description: '   ' },
    nodes: [],
    edges: [],
    chapters: [],
  });
  assert.equal(cover.hasSummary, false);
  assert.equal(cover.summary, '');
});

test('buildNarrativeCover: totalChunks 缺省时完整度视为 0（不假装 100%）', () => {
  const cover = buildNarrativeCover({
    project: { id: 1, name: 'X', description: '' },
    nodes: [{ id: 'a' }],
    edges: [{ source: 'a', target: 'a' }],
    chapters: [],
  });
  assert.equal(cover.completionPercent, 0);
  assert.equal(cover.completionFraction.completed, 0);
  assert.equal(cover.completionFraction.total, 0);
});

test('buildNarrativeCover: 简介合法、UI 元素可被安全访问（无 NaN / undefined）', () => {
  const cover = buildNarrativeCover({
    project: { id: 1, name: 'X' },
    nodes: [{ id: 'a' }],
    edges: [{ source: 'a', target: 'a' }],
    chapters: [],
    completedChunks: 1,
    totalChunks: 3,
  });
  // description 缺省时 summary 为空字符串；UI 层用 hasSummary=false 渲染「待补充」提示
  assert.equal(cover.summary, '');
  assert.equal(cover.hasSummary, false);
  // type 缺省时退化为「待补充」占位（项目类型不属于用户原文，UI 可以猜但需保留但不强求）
  assert.equal(cover.type, '待补充');
  // 完整度 = round(1/3 * 100) = 33
  assert.equal(cover.completionPercent, 33);
});

// ============================================================
// 人物洞察
// ============================================================

test('buildCharacterInsights: 无 profile 时返回 null（右侧面板显示占位）', () => {
  assert.equal(buildCharacterInsights(null, [], []), null);
  assert.equal(buildCharacterInsights(undefined, [], []), null);
});

test('buildCharacterInsights: 人物无邻居时核心度/转折数降为 0', () => {
  const profile = { id: 'a', label: '孤狼', sect: '', chapter: '' };
  const insights = buildCharacterInsights(profile, [], []);
  assert.equal(insights.label, '孤狼');
  // 没有 sect 也没有 chapter → summary 只包含人物名（label）
  assert.equal(insights.summary, '孤狼');
  assert.equal(insights.directRelationCount, 0);
  assert.equal(insights.turningPointCount, 0);
  assert.equal(insights.corePercent, 0);
  assert.deepEqual(insights.keyChanges, []);
  assert.equal(insights.noEvidence, true);
});

test('buildCharacterInsights: 直接关系数 = 邻接边去重后的不同邻居数', () => {
  const profile = { id: 'a', label: '甲', chapter: '第一章' };
  const edges = [
    { source: 'a', target: 'b', relationship: '友', chapter: '第一章', occurrence: 1 },
    { source: 'a', target: 'b', relationship: '友', chapter: '第二章', occurrence: 1 },
    { source: 'c', target: 'a', relationship: '敌', chapter: '第二章', occurrence: 1 },
  ];
  const insights = buildCharacterInsights(profile, edges, []);
  // b 在两条边里只算 1 个直接关系；c 是另一个
  assert.equal(insights.directRelationCount, 2);
});

test('buildCharacterInsights: 关键关系变化必须来自真实数据；无变化时 keyChanges 为 []', () => {
  const profile = { id: 'a', label: '甲', chapter: '序' };
  const edges = [
    { source: 'a', target: 'b', relationship: '盟友', chapter: '序', occurrence: 1 },
  ];
  const insights = buildCharacterInsights(profile, edges, []);
  // 单次「盟友」不存在「变化」，更没有第二个章节——不应该凭空编出「盟友 → 敌对」
  assert.deepEqual(insights.keyChanges, []);
  assert.equal(insights.turningPointCount, 0);
});

test('buildCharacterInsights: 同一对人物在不同章节呈现不同关系 → 计入关系转折', () => {
  const profile = { id: 'a', label: '甲', chapter: '序' };
  const nodes = [
    { id: 'a', label: '甲' },
    { id: 'b', label: '乙' },
    { id: 'c', label: '丙' },
  ];
  const edges = [
    { source: 'a', target: 'b', relationship: '盟友', chapter: '序', occurrence: 1 },
    { source: 'a', target: 'b', relationship: '对立', chapter: '中段', occurrence: 1 },
    { source: 'a', target: 'c', relationship: '友好', chapter: '末段', occurrence: 1 },
  ];
  const insights = buildCharacterInsights(profile, edges, nodes);
  // a-b 出现两次不同关系 → 是 1 次转折；a-c 单一关系 → 不是转折
  assert.equal(insights.turningPointCount, 1);
  assert.equal(insights.keyChanges.length, 1);
  assert.equal(insights.keyChanges[0].otherLabel, '乙');
  assert.equal(insights.keyChanges[0].fromLabel, '盟友');
  assert.equal(insights.keyChanges[0].toLabel, '对立');
  assert.deepEqual(insights.keyChanges[0].evidenceChapters, ['序', '中段']);
});

test('buildCharacterInsights: 核心度以「节点度数 / 总节点数」近似百分比 (0-100 整数)', () => {
  // 5 节点，a 连 4 条 → 80
  const profile = { id: 'a', label: '甲' };
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
    { source: 'a', target: 'd' },
    { source: 'a', target: 'e' },
    { source: 'b', target: 'c' },
  ];
  const insights = buildCharacterInsights(profile, edges, []);
  assert.equal(insights.corePercent, 80);
});

test('buildCharacterInsights: 所有边都没有 chapter 时，关键变化必须标注「暂无可追溯证据」', () => {
  const profile = { id: 'a', label: '甲' };
  const nodes = [
    { id: 'a', label: '甲' },
    { id: 'b', label: '乙' },
  ];
  const edges = [
    { source: 'a', target: 'b', relationship: '盟友' },
    { source: 'a', target: 'b', relationship: '对立' },
  ];
  const insights = buildCharacterInsights(profile, edges, nodes);
  assert.equal(insights.keyChanges.length, 1);
  assert.equal(insights.keyChanges[0].noEvidence, true);
  assert.equal(insights.keyChanges[0].fromLabel, '盟友');
  assert.equal(insights.keyChanges[0].toLabel, '对立');
  assert.equal(insights.keyChanges[0].otherLabel, '乙');
  assert.equal(insights.turningPointCount, 1);
  // 警示文案：相邻关系变化但没有可追溯章节 → 在 UI 上标记为「变化但无证据」
  assert.ok(insights.noEvidence || insights.keyChanges[0].noEvidence);
});

test('buildCharacterInsights: changes 按出现章节升序、稳定排序', () => {
  const profile = { id: 'a', label: '甲' };
  const nodes = [
    { id: 'a', label: '甲' },
    { id: 'b', label: '乙' },
    { id: 'c', label: '丙' },
    { id: 'd', label: '丁' },
  ];
  const edges = [
    { source: 'a', target: 'c', relationship: '敌', chapter: '末段', occurrence: 1 },
    { source: 'a', target: 'b', relationship: '盟友', chapter: '序', occurrence: 1 },
    { source: 'a', target: 'b', relationship: '对立', chapter: '中段', occurrence: 1 },
    { source: 'a', target: 'd', relationship: '友', chapter: '序', occurrence: 1 },
    { source: 'a', target: 'd', relationship: '敌', chapter: '中段', occurrence: 1 },
  ];
  const insights = buildCharacterInsights(profile, edges, nodes);
  // a-b (盟友→对立) evidenceChapters = ['序', '中段']
  // a-d (友→敌) evidenceChapters = ['序', '中段']
  // 按 (evidenceChapters[0], otherLabel code-point) 稳定排序：两者首章都是「序」，
  // 丁 (0x4E01) < 乙 (0x4E59) in Unicode codepoint → 丁 先、丙（单次不计）/ 乙 后。
  assert.equal(insights.keyChanges[0].otherLabel, '丁');
  assert.equal(insights.keyChanges[1].otherLabel, '乙');
  // 验证 evidence 列表也包含变化章节
  assert.deepEqual(insights.keyChanges[0].evidenceChapters, ['序', '中段']);
  assert.deepEqual(insights.keyChanges[0].fromLabel, '友');
  assert.deepEqual(insights.keyChanges[0].toLabel, '敌');
  assert.deepEqual(insights.keyChanges[1].fromLabel, '盟友');
  assert.deepEqual(insights.keyChanges[1].toLabel, '对立');
});

test('buildCharacterInsights: 摘要（summary）= 人物 + 阵营 + 登场章节组合而成的 1 行短句', () => {
  const profile = { id: 'a', label: '沈砚', sect: '查案者', chapter: '第 01 章' };
  const insights = buildCharacterInsights(profile, [], []);
  assert.match(insights.summary, /沈砚/);
  assert.match(insights.summary, /查案者/);
  assert.match(insights.summary, /第 01 章/);
});

test('buildCharacterInsights: 大量节点时核心度仍以归一化百分比（最大不超过 100）', () => {
  // 51 个节点（含 a），a 全部连接 → 50/51 ≈ 98
  const profile = { id: 'a', label: '甲' };
  const edges = [];
  const targetIds = Array.from({ length: 50 }, (_, i) => `n${i + 1}`);
  for (const t of targetIds) edges.push({ source: 'a', target: t });
  edges.push({ source: targetIds[0], target: targetIds[1] }); // 噪声边
  const insights = buildCharacterInsights(profile, edges, []);
  assert.equal(insights.corePercent, 98);
  assert.ok(insights.corePercent <= 100);
  assert.ok(insights.corePercent >= 0);
});
