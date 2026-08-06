import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectChapterRanges,
  getChapterForChunk,
  splitTextWithChapterContext,
} from './chapterSplitter.js';

// ==================== v19：detectChapterRanges ====================

test('detectChapterRanges：识别「第N章 标题」格式', () => {
  const text = '第一章 山边小村\n韩立是村里的小孩子。\n第二章 青牛镇\n韩立跟三叔到了青牛镇。';
  const ranges = detectChapterRanges(text);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].chapter, '第一章 山边小村');
  assert.equal(ranges[1].chapter, '第二章 青牛镇');
  assert.equal(ranges[0].start, 0);
  // 第二章起点：'第一章 山边小村\n韩立是村里的小孩子。\n第二章 ...' 中
  // 实际位置取决于文本长度
  assert.ok(ranges[1].start > ranges[0].start);
});

test('detectChapterRanges：识别「第N回 标题」（古典白话）', () => {
  const text = '第一回 甄士隐梦幻识通灵\n贾雨村罢了。\n第二回 贾夫人仙逝扬州城';
  const ranges = detectChapterRanges(text);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].chapter, '第一回 甄士隐梦幻识通灵');
  assert.equal(ranges[1].chapter, '第二回 贾夫人仙逝扬州城');
});

test('detectChapterRanges：识别「序」与「楔子」', () => {
  const text = '序\n这是序言。\n楔子\n这是楔子。\n第一章 正文\n继续';
  const ranges = detectChapterRanges(text);
  // 序、楔子、第一章 至少识别出 3 个
  assert.ok(ranges.length >= 3);
  assert.equal(ranges[0].chapter, '序');
  // 「楔子」出现在「第一章 正文」之前
  const xzIdx = ranges.findIndex((r) => r.chapter.startsWith('楔子'));
  assert.ok(xzIdx >= 0);
});

test('detectChapterRanges：「第零章」归一化为「第一章」', () => {
  const text = '第零章 序\n内容';
  const ranges = detectChapterRanges(text);
  assert.equal(ranges[0].chapter, '第一章 序');
});

test('detectChapterRanges：无章节标记返回空数组', () => {
  const text = '韩立是村里的小孩子，他每天都去山里砍柴。';
  const ranges = detectChapterRanges(text);
  assert.deepEqual(ranges, []);
});

test('detectChapterRanges：空文本返回空数组', () => {
  assert.deepEqual(detectChapterRanges(''), []);
  assert.deepEqual(detectChapterRanges(null), []);
});

test('detectChapterRanges：只识别章节标（无标题）', () => {
  const text = '第一章\n内容\n第二章\n更多';
  const ranges = detectChapterRanges(text);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].chapter, '第一章');
  assert.equal(ranges[1].chapter, '第二章');
});

// ==================== v19：getChapterForChunk ====================

test('getChapterForChunk：根据 chunkIndex 反查章节', () => {
  const text = '第一章 山边小村\n韩立是村里的小孩子。\n第二章 青牛镇\n韩立跟三叔到了青牛镇。\n第三章 七玄门\n韩立加入了七玄门。';
  // chunkSize=20 时：第一片(0-20)含「第一章 山边小村」全标题在 0-11，所以是「第一章」
  assert.equal(getChapterForChunk(0, 20, text), '第一章 山边小村');
  // 第二章起点大约在第 26 字后
  const chapter2Start = text.indexOf('第二章');
  // 找到第二章起点对应的 chunkIndex
  const idxForChapter2 = Math.floor(chapter2Start / 20);
  assert.equal(getChapterForChunk(idxForChapter2, 20, text), '第二章 青牛镇');
});

test('getChapterForChunk：越界 chunkIndex 返回最后一个章节', () => {
  const text = '第一章 A\n内容1\n第二章 B\n内容2';
  // chunkIndex 越大，越靠近末尾——末尾没有新章节，所以继承「第二章 B」
  // 取一个很大的 chunkIndex，确保已过第二章 start
  const chapter2Start = text.indexOf('第二章');
  const bigIdx = Math.floor(chapter2Start / 5) + 10;
  assert.equal(getChapterForChunk(bigIdx, 5, text), '第二章 B');
});

test('getChapterForChunk：chapterStart 在 chunk 起点之前的回退行为', () => {
  // 章节起点早于 chunkStart：取最近的「上一章」
  const text = '第一章 A\n很长的内容\n很长的内容\n很长的内容\n很长的内容';
  // chunkSize=100, chunkIndex=1 → chunkStart=100，远在「第一章」之后
  assert.equal(getChapterForChunk(1, 100, text), '第一章 A');
});

test('getChapterForChunk：非法参数返回空串', () => {
  assert.equal(getChapterForChunk(-1, 100, 'text'), '');
  assert.equal(getChapterForChunk(0, 0, 'text'), '');
  assert.equal(getChapterForChunk(0, 100, ''), '');
  assert.equal(getChapterForChunk(0, 100, null), '');
});

// ==================== v19：splitTextWithChapterContext ====================

test('splitTextWithChapterContext：每个 chunk 前面注入章节前缀', () => {
  const text = '第一章 山边小村\n韩立是村里的小孩子。\n第二章 青牛镇\n韩立跟三叔到了青牛镇。';
  const chunks = splitTextWithChapterContext(text, 30);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.match(c.text, /^\[当前章节：[^\]]+\]/);
  }
});

test('splitTextWithChapterContext：chunkIndex 与原 for-loop 切片对齐', () => {
  // 关键回归：chunkIndex 必须等于 i / chunkSize，确保 failureStore 重试用
  const text = '第一章 山边小村\n' + 'x'.repeat(1500) + '\n第二章 青牛镇\n' + 'y'.repeat(800);
  const chunks = splitTextWithChapterContext(text, 500);
  for (let i = 0; i < chunks.length; i += 1) {
    assert.equal(chunks[i].chunkIndex, i);
  }
  // 总长度应该和原 for-loop 一致
  const expectedCount = Math.ceil(text.length / 500);
  assert.equal(chunks.length, expectedCount);
});

test('splitTextWithChapterContext：chapter 字段正确反映章节', () => {
  const text = '第一章 山边小村\n' + 'x'.repeat(1500) + '\n第二章 青牛镇\n' + 'y'.repeat(800);
  const chunks = splitTextWithChapterContext(text, 500);
  // 前 3 个 chunk（0-1499）属于第一章
  assert.equal(chunks[0].chapter, '第一章 山边小村');
  assert.equal(chunks[1].chapter, '第一章 山边小村');
  assert.equal(chunks[2].chapter, '第一章 山边小村');
  // 后面属于第二章
  const last = chunks[chunks.length - 1];
  assert.equal(last.chapter, '第二章 青牛镇');
});

test('splitTextWithChapterContext：无章节标记时前缀为「未知」', () => {
  const text = '没有章节标记的小说段落。韩立是村里的小孩。' + 'x'.repeat(2000);
  const chunks = splitTextWithChapterContext(text, 500);
  for (const c of chunks) {
    assert.equal(c.chapter, '');
    assert.match(c.text, /^\[当前章节：未知\]/);
  }
});

test('splitTextWithChapterContext：空文本返回空数组', () => {
  assert.deepEqual(splitTextWithChapterContext('', 500), []);
  assert.deepEqual(splitTextWithChapterContext(null, 500), []);
});

test('splitTextWithChapterContext：极小 chunkSize 不会死循环', () => {
  const text = '第一章 A\n' + 'x'.repeat(1000);
  // 文本长度：'第一章 A\n' = 6 字符 + 1000 个 x = 1006
  const chunks = splitTextWithChapterContext(text, 1);
  assert.equal(chunks.length, 1006);
  // 每个 chunk 的 chunkIndex 严格递增
  for (let i = 0; i < chunks.length; i += 1) {
    assert.equal(chunks[i].chunkIndex, i);
  }
});

test('splitTextWithChapterContext：chunkSize 不是数字时回退到默认 500', () => {
  const text = '第一章 A\n' + 'x'.repeat(1500) + '\n第二章 B';
  const chunks = splitTextWithChapterContext(text, 'abc');
  // chunkSize 退到 500 → ceil(1509/500) = 4 片
  assert.equal(chunks.length, 4);
});