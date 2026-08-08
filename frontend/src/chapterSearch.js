// v26.3：章节搜索辅助纯函数（供 ChapterRangePicker 使用）
// parseChapterNumber：把「80 / 第80章 / 第八十章 / 八十 / １２３ / 一千零一章」解析成章节号
// filterChapters：按数字优先 + 文本子串 + 去空白模糊匹配排序

const CJK_DIGITS = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const CJK_UNITS = { 十: 10, 百: 100, 千: 1000 };

const SKIP_CHARS = new Set(['第', '章', '回', '节', '卷', '集', '篇']);

// 全角数字转半角（０-９ -> 0-9）
function normalizeFullWidthDigits(text) {
  return String(text).replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

// 解析章节号；无法解析返回 -1，无数字但可继续文本匹配返回 -1（调用方再用文本匹配）
export function parseChapterNumber(term) {
  if (term === null || term === undefined) return -1;
  const trimmed = String(term).trim();
  if (!trimmed) return -1;

  const half = normalizeFullWidthDigits(trimmed);
  const arabic = half.match(/\d+/);
  if (arabic) return parseInt(arabic[0], 10);

  let total = 0;
  let section = 0;
  let digitValue = -1;
  let hasCjkDigit = false;

  for (const ch of half) {
    if (CJK_UNITS[ch]) {
      const base = digitValue >= 0 ? digitValue : 1;
      section = (section + base) * CJK_UNITS[ch];
      total += section;
      section = 0;
      digitValue = -1;
      hasCjkDigit = true;
    } else if (ch in CJK_DIGITS) {
      digitValue = CJK_DIGITS[ch];
      hasCjkDigit = true;
    } else if (!SKIP_CHARS.has(ch)) {
      // 数字部分已经解析完（后面是章节名），结束解析
      if (hasCjkDigit || digitValue >= 0) break;
      return -1;
    }
  }

  if (!hasCjkDigit) return -1;
  return total + section + (digitValue >= 0 ? digitValue : 0);
}

// 过滤章节列表，返回 [{ range, originalIndex, score }]，已按分数降序
export function filterChapters(list, term) {
  const trimmed = String(term || '').trim();
  if (!trimmed) {
    return list.map((range, originalIndex) => ({ range, originalIndex, score: 0 }));
  }

  const lower = trimmed.toLowerCase();
  const wanted = parseChapterNumber(trimmed);
  const cleanTerm = lower.replace(/\s+/g, '');

  return list
    .map((range, originalIndex) => {
      const rawTitle = (range && typeof range === 'object') ? range.chapter : range;
      const title = String(rawTitle || '');

      const titleNum = parseChapterNumber(title);
      let score = -1;

      if (wanted > 0 && titleNum > 0) {
        if (titleNum === wanted) score = 1000;
        else if (String(titleNum).startsWith(String(wanted))) score = 700;
        else if (String(titleNum).includes(String(wanted))) score = 400;
      }

      if (score < 0 && title.toLowerCase().includes(lower)) score = 200;

      if (score < 0) {
        const cleanTitle = title.replace(/\s+/g, '');
        if (cleanTitle.includes(cleanTerm)) score = 150;
      }

      return { range, originalIndex, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
}

// 供测试使用
export const __internals = { CJK_DIGITS, CJK_UNITS, normalizeFullWidthDigits };