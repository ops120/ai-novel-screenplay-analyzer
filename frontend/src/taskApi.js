// taskApi.js
// Thin wrappers around the backend task engine endpoints.
// v28: backend task engine replaces in-browser execution; the frontend only
// creates/polls/patches/deletes tasks here.

import { API_BASE } from './config.js';

async function _jsonOrThrow(res) {
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body && body.detail ? body.detail : body;
    const err = new Error(detail?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    err.errorCode = detail?.error || '';
    throw err;
  }
  return body;
}

export async function listTasks(projectId) {
  if (!projectId) throw new Error('listTasks: projectId required');
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks`);
  return _jsonOrThrow(res);
}

export async function createTask(projectId, payload) {
  if (!projectId) throw new Error('createTask: projectId required');
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  return _jsonOrThrow(res);
}

export async function patchTask(projectId, taskId, payload) {
  if (!projectId || !taskId) throw new Error('patchTask: projectId+taskId required');
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    },
  );
  return _jsonOrThrow(res);
}

export async function deleteTask(projectId, taskId) {
  if (!projectId || !taskId) throw new Error('deleteTask: projectId+taskId required');
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'DELETE' },
  );
  return _jsonOrThrow(res);
}

// Map a backend task row to the shape the rest of the UI expects.
export function rowToTask(row) {
  if (!row) return null;
  const status = row.status || 'idle';
  const total = Number(row.totalChunks || row.total || 0);
  const completed = Number(row.completed || 0);
  const successCount = Number(row.successCount || 0);
  const failedCount = Number(row.failedCount || 0);
  const concurrency = Number(row.concurrency || 0);
  const chunkSize = Number(row.chunkSize || 0);
  const lastCompleted = Number(row.lastCompleted || 0);
  const createdAtMs = row.createdAt ? Date.parse(row.createdAt) || Date.now() : Date.now();
  const updatedAtMs = row.updatedAt ? Date.parse(row.updatedAt) || Date.now() : Date.now();
  const progress = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  let failedChunks = [];
  if (Array.isArray(row.failedIndexes)) {
    failedChunks = row.failedIndexes.map((idx, i) => ({
      chunkIndex: idx,
      message: '',
      status: '',
      _order: i,
    }));
  }
  let parsedChapter = { from: row.chapterFrom || '', to: row.chapterTo || '' };
  return {
    id: row.taskId || row.id,
    kind: row.kind || 'analyze',
    projectId: row.projectId,
    projectName: row.projectName || '',
    modelName: row.modelName || '',
    llmModelId: row.llmModelId || row.llm_model_id || '',
    status,
    total,
    overallTotal: total,
    completed,
    successCount,
    failedCount,
    rateLimitCount: Number(row.rateLimitCount || 0),
    degraded: !!row.degraded,
    initialConcurrency: concurrency,
    currentConcurrency: concurrency,
    concurrency,
    chapterFrom: parsedChapter.from,
    chapterTo: parsedChapter.to,
    createdAt: createdAtMs,
    startedAt: row.startedAt ? Date.parse(row.startedAt) || 0 : 0,
    finishedAt: row.finishedAt ? Date.parse(row.finishedAt) || 0 : 0,
    updatedAt: updatedAtMs,
    errorMessage: row.error || '',
    systemPrompt: row.systemPrompt || row.system_prompt || '',
    failedChunks,
    chunks: [],
    chunkMetas: [],
    startIndex: lastCompleted,
    progress,
    isPaused: status === 'paused',
    chunkSize,
    lastCompleted,
  };
}
