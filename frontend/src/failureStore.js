// v18：失败切片元数据持久化。
//
// 用户跑完一次分析后，失败的切片元数据写到 localStorage，UI 上点「重试」即可
// 只重跑那几片而不用从头跑。
//
// 设计要点：
//   1. 失败列表按 projectId 分组，避免项目间串扰
//   2. 原文也存（base64）—— 重试时要按 chunkIndex × chunkSize 切出对应切片
//   3. TTL 7 天 —— 超过自动清理（老失败列表很可能文本已变）
//   4. 体积估算：原文 max 200KB → base64 后约 270KB；5MB localStorage 够
//   5. 失败列表不存密码 / api_key，只存公开元数据

const STORAGE_KEY = 'storymap_analyze_failures';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safeLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readAll() {
  const storage = safeLocalStorage();
  if (!storage) return {};
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // QuotaExceededError 之类 —— 不阻塞主流程
    console.warn('失败列表持久化失败', e);
  }
}

// 清理过期的失败记录。返回清理后的全集。
function purgeExpired(all) {
  const now = Date.now();
  const kept = {};
  for (const [pid, entry] of Object.entries(all)) {
    if (entry && typeof entry.timestamp === 'number' && now - entry.timestamp < TTL_MS) {
      kept[pid] = entry;
    }
  }
  return kept;
}

/**
 * 保存某项目本次分析的失败切片列表。
 * @param {string} projectId
 * @param {object} payload
 *   - chunks: Array<{chunkIndex, message, status?}>
 *   - totalChunks: number
 *   - text: string                原文
 *   - chunkSize: number
 *   - concurrency: number
 *   - llmModelName: string        提示用，不参与重试逻辑
 *   - chapterFrom: number | ''    v20.4.2：保存本次范围，重试时按同一范围过滤
 *   - chapterTo:   number | ''
 */
export function saveFailure(projectId, payload) {
  if (!projectId) return;
  const all = purgeExpired(readAll());
  all[projectId] = {
    timestamp: Date.now(),
    totalChunks: payload.totalChunks,
    chunks: payload.chunks || [],
    text: encodeTextForStorage(payload.text || ''),
    chunkSize: payload.chunkSize,
    concurrency: payload.concurrency,
    llmModelName: payload.llmModelName || '',
    chapterFrom: payload.chapterFrom || '',
    chapterTo: payload.chapterTo || '',
  };
  writeAll(all);
}

export function getFailure(projectId) {
  if (!projectId) return null;
  const all = purgeExpired(readAll());
  const entry = all[projectId];
  if (!entry) return null;
  // v20.4.2：返回时解码 text，并补全 chapterFrom/To 字段（老记录无此字段）
  return {
    ...entry,
    text: decodeTextFromStorage(entry.text),
    chapterFrom: entry.chapterFrom || '',
    chapterTo: entry.chapterTo || '',
  };
}

export function clearFailure(projectId) {
  if (!projectId) return;
  const all = purgeExpired(readAll());
  delete all[projectId];
  writeAll(all);
}

export function listFailures() {
  const all = purgeExpired(readAll());
  return Object.entries(all).map(([projectId, entry]) => ({ projectId, ...entry }));
}

// ==================== 文本编解码 ====================
// TextEncoder 输出 Uint8Array；转成 latin1 字符串可走 btoa，绕开非 ASCII 抛错。
function encodeTextForStorage(text) {
  try {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch (e) {
    console.warn('encodeTextForStorage 失败', e);
    return '';
  }
}

export function decodeTextFromStorage(encoded) {
  if (typeof encoded !== 'string' || !encoded) return '';
  try {
    const bin = atob(encoded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    console.warn('decodeTextFromStorage 失败', e);
    return '';
  }
}