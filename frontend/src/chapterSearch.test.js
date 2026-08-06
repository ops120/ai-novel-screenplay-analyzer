import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChapterNumber, filterChapters, __internals } from './chapterSearch.js';

test('parseChapterNumber: 阿拉伯数字', () => {
  assert.equal(parseChapterNumber('80'), 80);
  assert.equal(parseChapterNumber('第80章'), 80);
  assert.equal(parseChapterNumber('123'), 123);
});

test('parseChapterNumber: 中文数字', () => {
  assert.equal(parseChapterNumber('第八十章'), 80);
  assert.equal(parseChapterNumber('八十'), 80);
  assert.equal(parseChapterNumber('第十章'), 10);
  assert.equal(parseChapterNumber('十'), 10);
  assert.equal(parseChapterNumber('第一百零五章'), 105);
  assert.equal(parseChapterNumber('一千零一章'), 1001);
  assert.equal(parseChapterNumber('零'), 0);
});

test('parseChapterNumber: 全角数字归一化', () => {
  assert.equal(parseChapterNumber('１２３'), 123);
  assert.equal(parseChapterNumber('第１２章'), 12);
});

test('parseChapterNumber: 无法解析', () => {
  assert.equal(parseChapterNumber('韩立'), -1);
  assert.equal(parseChapterNumber(''), -1);
  assert.equal(parseChapterNumber(null), -1);
  assert.equal(parseChapterNumber(undefined), -1);
});

test('parseChapterNumber: 数字优先于文本', () => {
  assert.equal(parseChapterNumber('第3卷'), 3);
});

test('filterChapters: 空 term 返回全部原始顺序', () => {
  const list = [{ chapter: '第十章' }, { chapter: '第十一章' }];
  const out = filterChapters(list, '');
  assert.equal(out.length, 2);
  assert.equal(out[0].originalIndex, 0);
});

test('filterChapters: 数字精确匹配优先', () => {
  const list = [
    { chapter: '第十章 入门' },
    { chapter: '第八十章 遇敌' },
    { chapter: '第十二章 试炼' },
    { chapter: '第八章 起步' },
  ];
  const out = filterChapters(list, '第八十章');
  assert.equal(out[0].originalIndex, 1);
  assert.equal(out[0].score, 1000);
});

test('filterChapters: 数字前缀/包含匹配', () => {
  const list = [
    { chapter: '第八章' },
    { chapter: '第八十章' },
    { chapter: '第一百八十章' },
    { chapter: '第一章' },
  ];
  const out = filterChapters(list, '80');
  assert.equal(out[0].range.chapter, '第八十章');
  assert.ok(out.some(x => x.range.chapter === '第一百八十章'));
});

test('filterChapters: 文本子串匹配', () => {
  const list = [
    { chapter: '第八十章 遇敌' },
    { chapter: '第十章 入门' },
    { chapter: '第二十章 重逢遇敌' },
  ];
  const out = filterChapters(list, '遇敌');
  assert.equal(out.length, 2);
  assert.equal(out[0].originalIndex, 0);
});

test('filterChapters: 去空白模糊匹配', () => {
  const list = [{ chapter: '第八十 章 遇敌' }, { chapter: '第一章 出发' }];
  const out = filterChapters(list, '八十章遇敌');
  assert.equal(out.length, 1);
  assert.equal(out[0].originalIndex, 0);
});

test('filterChapters: 无匹配返回空', () => {
  const list = [{ chapter: '第一章' }];
  assert.equal(filterChapters(list, '不存在').length, 0);
});

test('normalizeFullWidthDigits: 全角转半角', () => {
  assert.equal(__internals.normalizeFullWidthDigits('１２３'), '123');
  assert.equal(__internals.normalizeFullWidthDigits('abc'), 'abc');
});