import test from "node:test";
import assert from "node:assert/strict";
import { detectChapterRanges, splitTextWithChapterContext } from "./chapterSplitter.js";

function generateNovel(count, len) {
  const num = ["零","一","二","三","四","五","六","七","八","九","十","十一","十二","十三","十四","十五","十六","十七","十八","十九","二十","二十一","二十二","二十三","二十四","二十五","二十六","二十七","二十八","二十九","三十","三十一","三十二","三十三","三十四","三十五","三十六","三十七","三十八","三十九","四十","四十一","四十二","四十三","四十四","四十五","四十六","四十七","四十八","四十九","五十"];
  const lines = [];
  for (let c = 1; c <= count; c++) {
    lines.push("第" + num[c] + "章 标题" + c);
    lines.push(("第" + c + "章内容。").repeat(len));
  }
  return lines.join("\n");
}

function filterByChapter(metas, text, size, from, to) {
  if (!from && !to) return metas;
  const ranges = detectChapterRanges(text);
  const vf = Number.isFinite(Number(from)) && Number(from) >= 1 ? Math.floor(Number(from)) : 0;
  const vt = Number.isFinite(Number(to)) && Number(to) >= 1 ? Math.floor(Number(to)) : 0;
  return metas.filter((m) => {
    const s = m.chunkIndex * size;
    let ci = 0;
    for (let i = 0; i < ranges.length; i++) { if (ranges[i].start <= s) ci = i + 1; else break; }
    if (vf && ci < vf) return false;
    if (vt && ci > vt) return false;
    return true;
  });
}

function chapterIdx(text, size, meta) {
  const ranges = detectChapterRanges(text);
  const s = meta.chunkIndex * size;
  let ci = 0;
  for (let i = 0; i < ranges.length; i++) { if (ranges[i].start <= s) ci = i + 1; else break; }
  return ci;
}

test("50章检测", () => { assert.equal(detectChapterRanges(generateNovel(50,40)).length, 50); });

test("过滤[10,12]所有chunk在10-12章", () => {
  const t = generateNovel(50, 40);
  const s = 80;
  let m = splitTextWithChapterContext(t, s);
  const before = m.length;
  m = filterByChapter(m, t, s, 10, 12);
  assert.ok(m.length > 0 && m.length < before);
  for (const x of m) { const ci = chapterIdx(t, s, x); assert.ok(ci >= 10 && ci <= 12, "ci="+ci); }
});

test("mock fetch [10,12] chunk_index全部在范围内", async () => {
  const t = generateNovel(50, 40);
  const s = 80;
  let m = splitTextWithChapterContext(t, s);
  m = filterByChapter(m, t, s, 10, 12);
  const calls = [];
  for (let i = 0; i < m.length; i++) {
    calls.push({ ci: i, preview: m[i].text.substring(0, 80) });
  }
  for (const c of calls) {
    const mc = c.preview.match(/第(\d+)章内容/);
    if (mc) { const ch = Number(mc[1]); assert.ok(ch >= 10 && ch <= 12, "ci=" + c.ci + " chapter=" + ch); }
  }
  console.log("fetch calls for [10,12]: " + calls.length + " / total splits=" + Math.ceil(t.length / s));
});

test("retryFailedChunks: filtered-index vs global chunkIndex alignment", () => {
  const t = generateNovel(50, 40);
  const s = 80;
  let fm = splitTextWithChapterContext(t, s);
  fm = filterByChapter(fm, t, s, 10, 12);
  const failedIdx = 1;
  const failed = fm[failedIdx];
  const um = splitTextWithChapterContext(t, s);
  const bad = um[failedIdx];
  const good = um[failed.chunkIndex];
  const match = bad.chunkIndex === failed.chunkIndex;
  console.log("BUG-CHECK: filteredIdx=" + failedIdx + " -> bad.chunkIndex=" + bad.chunkIndex + " good.chunkIndex=" + good.chunkIndex + " match=" + match);
  if (!match) console.log("BUG FOUND: retryFailedChunks uses filtered-index to look up in unfiltered split");
});

test("continueAnalysis remaining stays in range", () => {
  const t = generateNovel(50, 40);
  const s = 80;
  let m = splitTextWithChapterContext(t, s);
  m = filterByChapter(m, t, s, 10, 12);
  const rem = m.slice(2);
  for (const x of rem) { assert.ok(chapterIdx(t, s, x) >= 10 && chapterIdx(t, s, x) <= 12); }
});

test("setChapterRange norm", () => {
  const n = (v) => { if (v === "" || v === null || v === undefined) return ""; const num = Number(v); return Number.isFinite(num) && num > 0 ? num : ""; };
  assert.equal(n("10"), 10); assert.equal(n(10), 10); assert.equal(n(""), ""); assert.equal(n("abc"), ""); assert.equal(n(-1), "");
});

test("只选第1章", () => { const t = generateNovel(50,40); const s=80; let m = splitTextWithChapterContext(t,s); m = filterByChapter(m,t,s,1,1); for (const x of m) assert.equal(chapterIdx(t,s,x), 1); });

test("from=10 to空", () => { const t = generateNovel(50,40); const s=80; let m = splitTextWithChapterContext(t,s); m = filterByChapter(m,t,s,10,""); for (const x of m) assert.ok(chapterIdx(t,s,x) >= 10); });

test("无范围不过滤", () => { const t = generateNovel(50,40); const s=80; let m = splitTextWithChapterContext(t,s); const orig=m.length; m=filterByChapter(m,t,s,"",""); assert.equal(m.length, orig); });
