import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFileText, isSmallPasteText } from './encodingDetect.js';

test('decodeFileText returns utf-8 for clean ASCII text', () => {
  const buf = new TextEncoder().encode('Hello World\nLine 2');
  const result = decodeFileText(buf);
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, 'Hello World\nLine 2');
});

test('decodeFileText returns utf-8 for clean Chinese UTF-8 text', () => {
  const src = '第一章 测试文本\n第二章 中文符号：，。！';
  const buf = new TextEncoder().encode(src);
  const result = decodeFileText(buf);
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, src);
});

test('decodeFileText falls back to gb18030 when UTF-8 produces too many replacement chars', () => {
  // 你好 的 GBK 字节：0xc4, 0xe3, 0xba, 0xc3。
  // 按 UTF-8 解码会产生 100% 替换符 → 必须回退到 gb18030。
  const gbkBytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
  const result = decodeFileText(gbkBytes);
  assert.equal(result.encoding, 'gb18030');
  assert.equal(result.text, '你好');
});

test('decodeFileText handles mixed Chinese + GBK punctuation', () => {
  // 模拟「GBK 中文段 + GBK 全角标点」混合
  // 「你好」= 0xc4 0xe3 0xba 0xc3（GBK）
  // 「，」= 0xa3 0xac（GBK）
  // 「。」= 0xa1 0xa3（GBK）
  const gbkBytes = new Uint8Array([
    0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xa1, 0xa3,
  ]);
  const result = decodeFileText(gbkBytes);
  assert.equal(result.encoding, 'gb18030');
  assert.equal(result.text, '你好，。');
});

test('isSmallPasteText returns true for short pastes', () => {
  assert.equal(isSmallPasteText('短文本'), true);
  assert.equal(isSmallPasteText(''), true);
});

test('isSmallPasteText returns false for >100KB pastes', () => {
  const huge = 'x'.repeat(100 * 1024 + 1);
  assert.equal(isSmallPasteText(huge), false);
});
