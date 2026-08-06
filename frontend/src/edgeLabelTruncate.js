// v26.2.3：关系图谱边标签的多行截断纯函数。
// 默认按字符截断（紧凑单行）；多行按词（→ / 空格 / —）拆分后拼成多行。

const SEPARATORS = [' → ', '->', ' — ', '--', '、', ' ', '/'];

// 单行最多显示多少字符（中文按 1 字符，英文按 1 字符）。
const SINGLE_LINE_MAX_CHARS = 14;

// 多行每行最多多少字符（防止某一词过长撑爆布局）。
const MULTI_LINE_MAX_CHARS_PER_LINE = 24;

// 末尾省略号占位。
const ELLIPSIS = '…';

function truncateChars(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, maxChars - 1)) + ELLIPSIS;
}

// 把长文本按分隔符切成词数组。
function tokenize(text) {
  if (!text) return [];
  const pattern = new RegExp(`(${SEPARATORS.map(s => s.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  const parts = text.split(pattern).filter(p => p !== '');
  return parts;
}

// 把词数组按行容量贪心装箱：尽量多装，少换行；超过容量则换行。
function wrapTokens(tokens, maxCharsPerLine) {
  const lines = [];
  let current = '';
  for (const token of tokens) {
    if (!current.length) {
      current = token;
      continue;
    }
    const tentative = current + token;
    if (tentative.length > maxCharsPerLine) {
      lines.push(current);
      current = token;
    } else {
      current = tentative;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// 把多行截断到 maxLines 行；超出部分用 … 收尾。
function limitLines(lines, maxLines) {
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = last + ELLIPSIS;
  return kept;
}

// 主入口：根据最大行数截断标签。
// lines === 1  -> 字符级单行截断（默认最紧凑）。
// lines >= 2  -> 按词拆分并按 maxCharsPerLine 折行，再截到 lines 行。
export function truncateLabelForLines(text, lines = 1) {
  const safeLines = Number.isFinite(lines) && lines >= 1 ? Math.floor(lines) : 1;
  const safeText = typeof text === 'string' ? text : '';

  if (safeText === '') return '';

  if (safeLines === 1) {
    return truncateChars(safeText, SINGLE_LINE_MAX_CHARS);
  }

  const tokens = tokenize(safeText);
  if (tokens.length === 0) return '';

  const wrapped = wrapTokens(tokens, MULTI_LINE_MAX_CHARS_PER_LINE);
  return limitLines(wrapped, safeLines).join('\n');
}

// 暴露给测试的内部常量/函数。
export const __internals = {
  SEPARATORS,
  SINGLE_LINE_MAX_CHARS,
  MULTI_LINE_MAX_CHARS_PER_LINE,
  ELLIPSIS,
  truncateChars,
  tokenize,
  wrapTokens,
  limitLines,
};