// v25-fix：炼化进度持久化改为本地后端 SQLite 持久化。
//
// 历史：
//   v20-v24 用浏览器 localStorage，整篇原文 base64 写入；5MB 配额对百万字长卷是
//   致命瓶颈（999 项目 15MB 文本写不进去，刷新后整页空空如也）。
//
// 这次改造：
//   - 全部走 fetch + 本地 FastAPI（/api/task-progress），无 localStorage 依赖。
//   - saveProgress 走 PUT（专用 64MB 通道）一次写完整篇原文 + 切片参数。
//   - updateProgress 走 PATCH 只更新 lastCompleted（不再重传原文，断点节省带宽）。
//   - getProgress 走 GET 单条（含 text）；listProgress 走 GET 列表（不含 text，
//     避免一次拉几 MB → 几十 MB 进内存）。
//   - clearProgress 走 DELETE（完成/放弃时调用）。
//   - 返回值统一 Promise；HTTP 错误抛错让调用方知晓（store / taskManager
//     据此决定是否回退到「无断点」状态）。

import { API_BASE } from './config.js';

function endpoint(projectId) {
  const pid = encodeURIComponent(String(projectId ?? ''));
  return `${API_BASE}/task-progress/${pid}`;
}

async function readJsonOrThrow(res) {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // 忽略：有些端点返纯文本/空 body
    }
    throw new Error(`HTTP ${res.status} ${res.statusText || ''} ${detail}`.trim());
  }
  return res.json();
}

/**
 * 落盘或更新炼化进度（首次写、每次切片进度更新都走它）。
 *
 * 注意：taskManager.executeTask 启动时必须 await 此调用成功，
 * 否则刷新就丢断点。
 *
 * @param {string} projectId
 * @param {object} payload
 *   - totalChunks: number
 *   - lastCompleted: number
 *   - text: string            原文（最大约 64MB UTF-8）
 *   - chunkSize: number
 *   - concurrency: number
 *   - llmModelName: string
 *   - chapterFrom: string
 *   - chapterTo: string
 * @returns {Promise<object>} 后端响应（含 status: 'success'）
 */
export async function saveProgress(projectId, payload) {
  if (!projectId) throw new Error('saveProgress: projectId 必填');
  const body = {
    active: true,
    timestamp: Date.now(),
    totalChunks: payload.totalChunks,
    lastCompleted: payload.lastCompleted || 0,
    text: payload.text || '',
    chunkSize: payload.chunkSize,
    concurrency: payload.concurrency,
    llmModelName: payload.llmModelName || '',
    chapterFrom: payload.chapterFrom || '',
    chapterTo: payload.chapterTo || '',
  };
  const res = await fetch(endpoint(projectId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJsonOrThrow(res);
}

/**
 * 单条断点详情（含原文）。仅在「点击继续」时调用，避免列表阶段拉大文本。
 * @returns {Promise<object|null>} 不存在时返 null
 */
export async function getProgress(projectId) {
  if (!projectId) return null;
  // 不显式传 method：fetch 默认 GET，避免测试 mock 把 method:'GET' 当作自定义请求
  const res = await fetch(endpoint(projectId));
  if (res.status === 404) return null;
  return readJsonOrThrow(res);
}

/**
 * 全部 active 断点列表（不含 text）。刷新初始化用。
 * @returns {Promise<Array>}
 */
export async function listProgress() {
  const res = await fetch(`${API_BASE}/task-progress`);
  return readJsonOrThrow(res);
}

/**
 * 增量更新 lastCompleted（不重传原文，单调不回退由后端 MAX 保证）。
 *
 * @param {string} projectId
 * @param {{ lastCompleted: number }} patch
 * @param {AbortSignal} [signal] 外部取消信号。任务被 abort 时透传，让 fire-and-forget
 *        路径的 onProgress 也能被取消，避免「任务已取消还在写断点」的诡异副作用。
 */
export async function updateProgress(projectId, patch, signal) {
  if (!projectId) throw new Error('updateProgress: projectId 必填');
  if (!patch || typeof patch.lastCompleted !== 'number') {
    throw new Error('updateProgress: payload.lastCompleted 必填');
  }
  const res = await fetch(endpoint(projectId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastCompleted: patch.lastCompleted }),
    ...(signal ? { signal } : {}),
  });
  return readJsonOrThrow(res);
}

/**
 * 删除某项目的断点（任务完成或用户放弃时调用）。
 */
export async function clearProgress(projectId) {
  if (!projectId) return;
  const res = await fetch(endpoint(projectId), { method: 'DELETE' });
  // 404 表示「本来就没有」——视为成功，避免无意义的重试。
  if (res.status === 404) return { status: 'success', projectId };
  return readJsonOrThrow(res);
}