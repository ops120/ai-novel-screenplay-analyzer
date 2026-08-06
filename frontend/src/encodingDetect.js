// v26.1：导入文本编码探测（UTF-8 → GB18030 → GBK 回退）。
//
// 思路：
//   1. 先按 UTF-8 解码整个 ArrayBuffer；
//   2. 统计 U+FFFD 替换符占总字符数的占比；
//   3. 占比 > 1%（或至少出现一个替换符）视为乱码，按 GB18030 重读；
//      GB18030 是 GBK 的超集，能覆盖绝大多数中文 Windows .txt。
//
// 公开 API：
//   decodeFileText(arrayBuffer): { text, encoding }

const REPLACEMENT_RATIO_THRESHOLD = 0.01; // 1% 以上 U+FFFD 视为乱码

export function decodeFileText(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array
    ? arrayBuffer
    : new Uint8Array(arrayBuffer);

  // 先按 UTF-8 解码（无 fatal=true，替换符自然出现）
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const total = utf8.length || 1;
  let replacement = 0;
  for (let i = 0; i < utf8.length; i += 1) {
    if (utf8.charCodeAt(i) === 0xfffd) replacement += 1;
  }
  if (replacement === 0 || replacement / total < REPLACEMENT_RATIO_THRESHOLD) {
    return { text: utf8, encoding: 'utf-8' };
  }

  // GB18030 兜底：是 GBK 的超集，覆盖几乎所有 GBK 中文文本
  try {
    const gb = new TextDecoder('gb18030').decode(bytes);
    return { text: gb, encoding: 'gb18030' };
  } catch {
    return { text: utf8, encoding: 'utf-8' };
  }
}

// 小文本粘贴路径的兜底编码（粘贴一定来自 JS 字符串，无需探测）
export function isSmallPasteText(text) {
  return typeof text === 'string' && text.length <= 100 * 1024;
}
