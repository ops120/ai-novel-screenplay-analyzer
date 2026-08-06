import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateLabelForLines,
  __internals,
} from './edgeLabelTruncate.js';

const {
  SINGLE_LINE_MAX_CHARS,
  truncateChars,
  tokenize,
  wrapTokens,
  limitLines,
} = __internals;

test('truncateLabelForLines: 1 行默认按字符截断', () => {
  assert.equal(truncateLabelForLines('韩立', 1), '韩立');
});

test('truncateLabelForLines: 1 行时超长用 … 截断', () => {
  const long = '仇敌 → 敌对 → 元神被反吞噬 — 欲合作寻肉身 — 设计夺舍渔翁得利';
  const out = truncateLabelForLines(long, 1);
  assert.ok(out.length <= SINGLE_LINE_MAX_CHARS, `len=${out.length}`);
  assert.ok(out.endsWith('…'), `应带省略号, got=${out}`);
  assert.ok(out.includes('仇敌'), '应保留开头词');
});

test('truncateLabelForLines: lines=0/负数/NaN 视为 1 行', () => {
  assert.equal(truncateLabelForLines('韩立 ×3', 0).length, '韩立 ×3'.length);
  assert.equal(truncateLabelForLines('韩立 ×3', -1).length, '韩立 ×3'.length);
  assert.equal(truncateLabelForLines('韩立 ×3', NaN).length, '韩立 ×3'.length);
});

test('truncateLabelForLines: 非字符串输入返回空', () => {
  assert.equal(truncateLabelForLines(undefined, 1), '');
  assert.equal(truncateLabelForLines(null, 2), '');
  assert.equal(truncateLabelForLines(123, 3), '');
});

test('truncateLabelForLines: 3 行时按词换行并截到 3 行', () => {
  const long = '仇敌 → 敌对 → 元神被反吞噬 — 欲合作寻肉身 — 设计夺舍渔翁得利 — 假装同意合作';
  const out = truncateLabelForLines(long, 3);
  const lineCount = out.split('\n').length;
  assert.ok(lineCount <= 3, `应不超过 3 行, got ${lineCount}: ${out}`);
  assert.equal(truncateLabelForLines('韩立 ×3', 3), '韩立 ×3');
});

test('truncateLabelForLines: 5 行时 ≤ 5 行', () => {
  const text = '甲 → 乙 → 丙 → 丁 → 戊 → 己 → 庚 → 辛 → 壬 → 癸';
  const out = truncateLabelForLines(text, 5);
  assert.ok(out.split('\n').length <= 5);
});

test('truncateLabelForLines: 多行模式下超出末行加 …', () => {
  const text = '仇敌 → 敌对 → 元神被反吞噬 — 欲合作寻肉身 — 设计夺舍渔翁得利 — 假装同意合作 → 仇敌/审讯者与被审讯者 → 夺舍未遂 → 吞噬部分亲子童';
  const out = truncateLabelForLines(text, 2);
  assert.ok(out.includes('\n'), '多行应包含换行');
  assert.ok(out.endsWith('…'), '超长末行应带省略号');
});

test('truncateChars: 边界值原样返回', () => {
  const text = 'a'.repeat(SINGLE_LINE_MAX_CHARS);
  assert.equal(truncateChars(text, SINGLE_LINE_MAX_CHARS), text);
});

test('tokenize: 拆分包含 → / — 的复合标签', () => {
  const tokens = tokenize('仇敌 → 敌对 — 元神被反吞噬');
  assert.ok(tokens.includes('仇敌'));
  assert.ok(tokens.includes(' → '));
  assert.ok(tokens.includes('敌对'));
  assert.ok(tokens.includes(' — '));
  assert.ok(tokens.includes('元神被反吞噬'));
});

test('wrapTokens: 贪心装箱, 行内字符数不超过 maxCharsPerLine', () => {
  const tokens = tokenize('仇敌 → 敌对 → 元神被反吞噬');
  const wrapped = wrapTokens(tokens, 10);
  assert.ok(wrapped.length >= 1);
  for (const line of wrapped) {
    assert.ok(line.length <= 10, `line too long: "${line}"`);
  }
});

test('limitLines: 超出 maxLines 时末行加 …', () => {
  const limited = limitLines(['a', 'b', 'c', 'd', 'e'], 2);
  assert.equal(limited.length, 2);
  assert.ok(limited[1].endsWith('…'));
});

test('limitLines: 未超出时原样返回', () => {
  const limited = limitLines(['a', 'b'], 5);
  assert.deepEqual(limited, ['a', 'b']);
});