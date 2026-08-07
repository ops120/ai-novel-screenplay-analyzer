// v26.3：失败切片记录持久化迁移到后端 SQLite。
//
// 历史：v18-v26.2 用浏览器 localStorage（5MB 配额对长篇不够），
// key='storymap_analyze_failures', TTL 7 天。
//
// 现在：
//   - 全部走 fetch + 本地 FastAPI（/api/projects/{pid}/failure），无 localStorage 依赖。
//   - saveFailure 走 PUT（upsert），getFailure 走 GET，clearFailure 走 DELETE（幂等）。
//   - 返回值统一 Promise；HTTP 错误抛错让调用方知晓。
//   - listFailures 不再提供（历史仅测试用，无调用方）。
//
// 老 localStorage 数据不再迁移，作废——后端返回 404 时视为「无失败记录」。

import { API_BASE } from './config.js';

function endpoint(projectId) {
  const pid = encodeURIComponent(String(projectId ?? ''));
  return `${API_BASE}/projects/${pid}/failure`;
}

async function readJsonOrThrow(res) {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // 忽略：404 detail 不一定有 body
    }
    throw new Error(`HTTP ${res.status} ${res.statusText || ''} ${detail}`.trim());
  }
  return res.json();
}

/**
 * 保存失败切片记录（upsert）。
 * @param {string} projectId
 * @param {object} payload
 *   - chunkSize: number
 *   - totalChunks: number
 *   - chunks: Array<{chunkIndex, message, status?}>
 *   - chapterFrom: string
 *   - chapterTo: string
 * @returns {Promise<object>} 后端响应
 */
export async function saveFailure(projectId, payload) {
  if (!projectId) throw new Error('saveFailure: projectId 必填');
  const body = {
    chunkSize: payload.chunkSize || 0,
    totalChunks: payload.totalChunks || 0,
    chunks: Array.isArray(payload.chunks) ? payload.chunks : [],
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
 * 读失败记录。无记录时返回 null（与历史 localStorage 版兼容：调用方习惯 null 当作「无」）。
 * @returns {Promise<object|null>}
 */
export async function getFailure(projectId) {
  if (!projectId) return null;
  const res = await fetch(endpoint(projectId));
  if (res.status === 404) return null;
  return readJsonOrThrow(res);
}

/**
 * 清空失败记录。幂等——无记录也返回成功。
 * 不存在项目 → 404 抛错（与后端契约一致）。
 */
export async function clearFailure(projectId) {
  if (!projectId) return;
  const res = await fetch(endpoint(projectId), { method: 'DELETE' });
  if (res.status === 404) {
    // 项目不存在：视为幂等成功（与原 localStorage 行为一致——不存在就是清掉了）。
    return { status: 'success', projectId, deleted: true };
  }
  return readJsonOrThrow(res);
}