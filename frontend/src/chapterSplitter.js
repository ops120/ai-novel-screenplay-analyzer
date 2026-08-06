// v19：章节边界智能切片。
//
// 背景：v15 引入 chapter 字段后，chapter 来源完全靠 LLM 在响应里手填。
// 但实测 MiniMax Token Plan 模型经常忽略 chapter 字段（凡人修仙传 35 节点
// / 56 边全空，但文本里有 10 处「第N章」标记），造成 UI 永远显示「未标注章节」。
//
// v19 方案：客户端扫描章节边界，每个 chunk 前面注入「[当前章节：XXX]」前缀，
// 让 LLM 直接照搬；同时后端接收 chunk_chapter 字段作为 LLM 不填时的兜底。

const ZH_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// 章节识别规则（按优先级）。匹配组：第 1 组为可省略的章节号，第 2 组为标题。
const CHAPTER_PATTERNS = [
  /^第([零〇一二三四五六七八九十百千]+)章[ 　　]*([^\n\r]{0,30})/,
  /^第([零〇一二三四五六七八九十百千]+)回[ 　　]*([^\n\r]{0,30})/,
  /^(序章|序言)[ 　　]*([^\n\r]{0,30})?/,
  /^序[ 　　]*([^\n\r]{0,30})?/,
  /^(楔子|引子|终章)[ 　　]*([^\n\r]{0,30})?/,
];

function normalizeNum(zh) {
  if (!zh) return zh;
  if (zh === '零' || zh === '〇') return '一';  // 第零章 → 第一章（防 LLM 误读）
  return zh;
}

function formatChapter(match) {
  if (/^第/.test(match[0])) {
    const num = normalizeNum(match[1]);
    // 用「数字后紧跟的字符」判定章/回，而不是搜索标题里的「回」字。
    // 例如「第一章 回访故乡」若用 /第.+回/ 会误判成「第一回」。
    // 「第」占 1 位，数字占 match[1].length 位，紧跟的字符就是章/回。
    const tag = match[0].charAt(1 + match[1].length) === '回' ? '回' : '章';
    const title = (match[2] || '').trim();
    return title ? `第${num}${tag} ${title}` : `第${num}${tag}`;
  }
  if (/^序/.test(match[0])) {
    const tag = match[0].startsWith('序章') || match[0].startsWith('序言') ? match[0].slice(0, 2) : '序';
    const title = (match[1] || '').trim();
    return title ? `${tag} ${title}` : tag;
  }
  const tag = match[0].slice(0, 2);
  const title = (match[1] || '').trim();
  return title ? `${tag} ${title}` : tag;
}

// 扫描文本，返回 [{chapter, start}]，按 start 升序去重。
export function detectChapterRanges(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matches = [];

  for (const regex of CHAPTER_PATTERNS) {
    const re = new RegExp(regex.source, 'gm');
    let m;
    while ((m = re.exec(text)) !== null) {
      const chapter = formatChapter(m).replace(/\s+/g, ' ').trim();
      if (!chapter) continue;
      matches.push({ chapter, start: m.index });
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }

  if (matches.length === 0) return [];

  matches.sort((a, b) => a.start - b.start);
  const dedup = [];
  for (const m of matches) {
    if (dedup.length === 0 || m.start > dedup[dedup.length - 1].start) {
      dedup.push(m);
    }
  }
  return dedup;
}

// 给定切片下标，返回它对应的章节名（向后匹配——「上一章」就近）。
// chunkIndex × chunkSize 是 chunk 的绝对起点，与「for i += chunkSize」切片 100% 对齐。
export function getChapterForChunk(chunkIndex, chunkSize, fullText, ranges = null) {
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) return '';
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) return '';
  if (typeof fullText !== 'string') return '';
  const rs = ranges || detectChapterRanges(fullText);
  if (rs.length === 0) return '';
  const chunkStart = chunkIndex * chunkSize;
  let current = '';
  for (const r of rs) {
    if (r.start <= chunkStart) current = r.chapter;
    else break;
  }
  return current;
}

/**
 * 智能切片：返回 [{text, chapter, chunkIndex}]。
 *
 * - 按 chunkSize 等距切（与原 for-loop 100% 对齐，failureStore 重试路径不受影响）
 * - 每个 chunk 前面注入 `[当前章节：XXX]` 前缀（XXX 为该 chunk 对应的章节）
 * - chapter 字段同时返回，供后端 / failureStore 兜底
 */
export function splitTextWithChapterContext(fullText, chunkSize) {
  const safeChunkSize = Math.max(1, Math.floor(Number(chunkSize) || 500));
  if (typeof fullText !== 'string' || fullText.length === 0) return [];
  const ranges = detectChapterRanges(fullText);

  const chunks = [];
  const total = fullText.length;
  for (let i = 0, idx = 0; i < total; i += safeChunkSize, idx += 1) {
    const end = Math.min(i + safeChunkSize, total);
    const slice = fullText.slice(i, end);
    const chapter = getChapterForChunk(idx, safeChunkSize, fullText, ranges);
    const prefix = chapter ? `[当前章节：${chapter}]` : '[当前章节：未知]';
    chunks.push({
      text: `${prefix}\n${slice}`,
      chapter,
      chunkIndex: idx,
    });
  }
  return chunks;
}