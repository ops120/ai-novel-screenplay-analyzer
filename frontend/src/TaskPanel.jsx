// v24：分析任务管理面板（右侧抽屉）。
//
// - 只读 store.tasks；通过 store 的 pauseTaskById / resumeTaskById / cancelTaskById / removeTaskById 操作。
// - 列表按 status 优先级 + createdAt 倒序：running → paused → failed → completed → cancelled
// - 状态徽章 + 进度条 + 已/总 + 失败数 + 模型名 + 章节范围
// - 操作按钮按 status 显示（暂停仅 running/idle 可见；继续仅 paused 可见；取消仅 active 可见）
// - 失败切片行可展开

import React, { useMemo, useRef, useState } from 'react';
import { useStore } from './store.js';
import { buildTaskGuide, resolveTaskProjectName } from './taskGuide.js';

const STATUS_LABELS = {
  idle: '排队中',
  running: '运行中',
  paused: '已暂停',
  interrupted: '已中断 · 待继续',
  completed: '已完成',
  failed: '有失败',
  cancelled: '已取消',
};

const STATUS_ORDER = ['running', 'paused', 'interrupted', 'idle', 'failed', 'completed', 'cancelled'];

const KIND_LABELS = {
  analyze: '全新分析',
  continue: '续跑',
  retry: '重试失败',
};

function statusClass(status) {
  return `task-status task-status-${status}`;
}

function formatRange(from, to) {
  if (!from && !to) return '全部章节';
  if (from && to) return `第 ${from} 章 – 第 ${to} 章`;
  if (from) return `第 ${from} 章起`;
  if (to) return `到第 ${to} 章止`;
  return '';
}

function TaskRow({ task, projectName, isCurrentProject, onPause, onResume, onCancel, onRemove, onFocus }) {
  const failedChunks = task.failedChunks || [];
  const showFailedToggle = failedChunks.length > 0;
  const detailsRef = useRef(null);

  // 展开失败切片（默认收起）
  const [expanded, setExpanded] = React.useState(false);

  return (
    <li className={`task-row${isCurrentProject ? ' task-row-current' : ''}`}>
      <div className="task-row-head">
        <div className="task-row-title">
          <button
            type="button"
            className="task-row-name"
            onClick={() => onFocus(task.projectId)}
            title="切换到此项目"
          >
            {projectName}
          </button>
          <span className={statusClass(task.status)}>{STATUS_LABELS[task.status] || task.status}</span>
        </div>
        <div className="task-row-meta">
          <span className="task-kind">{KIND_LABELS[task.kind] || task.kind}</span>
          {task.modelName && <span className="task-model">· {task.modelName}</span>}
        </div>
      </div>

      <div className="task-progress-row">
        <div
          className="task-progress-bar"
          role="progressbar"
          aria-valuenow={task.progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="task-progress-fill" style={{ width: `${task.progress}%` }} />
        </div>
        <div className="task-progress-text">
          {task.completed}/{task.total}
          {task.failedCount > 0 && (
            <span className="task-failed-count"> · 失败 {task.failedCount}</span>
          )}
          {task.degraded && (
            <span className="task-degraded"> · 已降级</span>
          )}
        </div>
      </div>

      <div className="task-range">{formatRange(task.chapterFrom, task.chapterTo)}</div>

      <div className="task-row-actions">
        {(task.status === 'running' || task.status === 'idle') && (
          <button type="button" className="ghost-button" onClick={() => onPause(task.id)}>暂停</button>
        )}
        {/* v25：interrupted 复用「继续」入口；store 会把它路由到真实的续跑流程。
            恢复项没有执行器，因此不给暂停/取消，只给继续与删除。 */}
        {(task.status === 'paused' || task.status === 'interrupted') && (
          <button type="button" className="ghost-button" onClick={() => onResume(task.id)}>继续</button>
        )}
        {(task.status === 'running' || task.status === 'paused' || task.status === 'idle') && (
          <button type="button" className="ghost-button danger" onClick={() => onCancel(task.id)}>取消</button>
        )}
        {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted') && (
          <button type="button" className="ghost-button" onClick={() => onRemove(task.id)}>删除</button>
        )}
        {showFailedToggle && (
          <button
            type="button"
            className="ghost-button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? '收起失败切片' : `查看失败切片（${failedChunks.length}）`}
          </button>
        )}
      </div>

      {expanded && showFailedToggle && (
        <ul className="task-failed-list" ref={detailsRef}>
          {failedChunks.slice(0, 50).map((c) => (
            <li key={c.chunkIndex} className="task-failed-item">
              <span className="task-failed-idx">切片 {c.chunkIndex + 1}</span>
              <span className="task-failed-msg">
                {c.status ? `[${c.status}] ` : ''}{c.message || '未知错误'}
              </span>
            </li>
          ))}
          {failedChunks.length > 50 && (
            <li className="task-failed-more">…还有 {failedChunks.length - 50} 个</li>
          )}
        </ul>
      )}
    </li>
  );
}

export default function TaskPanelBody({ guideState, onGuide }) {
  const tasks = useStore((s) => s.tasks || []);
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const selectProject = useStore((s) => s.selectProject);
  const pauseTaskById = useStore((s) => s.pauseTaskById);
  const resumeTaskById = useStore((s) => s.resumeTaskById);
  const cancelTaskById = useStore((s) => s.cancelTaskById);
  const removeTaskById = useStore((s) => s.removeTaskById);
  const continueAnalysis = useStore((s) => s.continueAnalysis);

  // v25 修复：interrupted 任务的「继续」要走真实的续跑流程（createContinueTask），
  // 而不是 resumeTaskById（后者只翻 isPaused，对没有 Promise/AbortController 的
  // interrupted 展示态无效）。paused 任务仍走 resumeTaskById。
  const handleResume = (taskId) => {
    const t = tasks.find(x => x.id === taskId);
    if (!t) return;
    if (t.status === 'interrupted') {
      if (t.projectId && String(t.projectId) !== String(currentProjectId)) {
        selectProject(t.projectId);
      }
      continueAnalysis();
    } else {
      resumeTaskById(taskId);
    }
  };

  const sortedTasks = useMemo(() => {
    return tasks.slice().sort((a, b) => {
      const sa = STATUS_ORDER.indexOf(a.status);
      const sb = STATUS_ORDER.indexOf(b.status);
      if (sa !== sb) return sa - sb;
      return b.createdAt - a.createdAt;
    });
  }, [tasks]);

  // v25：恢复项的 projectId 来自 progressStore 对象键（字符串），项目列表 id 是数字，
  // 必须转成字符串比较，否则恢复行永远高亮不出「当前项目」。
  const handleFocus = (projectId) => {
    if (projectId && String(projectId) !== String(currentProjectId)) {
      selectProject(projectId);
    }
  };

  const counts = useMemo(() => {
    const c = { total: tasks.length, running: 0, paused: 0, interrupted: 0, failed: 0, completed: 0, cancelled: 0 };
    for (const t of tasks) {
      if (c[t.status] !== undefined) c[t.status] += 1;
    }
    return c;
  }, [tasks]);

  // v25：仅在真正无任务时计算引导（有任务时这份结果不会被渲染）
  const guide = useMemo(() => buildTaskGuide(guideState || {}), [guideState]);

  // 状态徽章行（被 App.jsx 的 nl-left-drawer-header 之外的 TaskPanelBody 使用，
  // 这里把它放在 body 顶部，header 中的关闭按钮由 App.jsx 的 nl-left-drawer-close 提供）
  return (
    <div className="task-panel-body">
      {sortedTasks.length === 0 ? (
        <div className="task-panel-empty">
          <div className="task-empty-icon" aria-hidden="true">📜</div>
          <div className="task-empty-title">暂无分析任务</div>
          <div className="task-empty-hint">按下面四步准备好，即可开始分析</div>
          <ol className="task-guide">
            {guide.steps.map((step, index) => (
              <li key={step.id} className={`task-guide-step ${step.state}`}>
                <span className="task-guide-marker" aria-hidden="true">
                  {step.state === 'done' ? '✓' : index + 1}
                </span>
                <span className="task-guide-text">{step.title}</span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="ghost-button task-guide-action"
            onClick={() => onGuide?.(guide.target)}
          >
            {guide.actionLabel}
          </button>
        </div>
      ) : (
        <ul className="task-list">
          {sortedTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              projectName={resolveTaskProjectName(t, projects)}
              isCurrentProject={String(t.projectId) === String(currentProjectId)}
              onPause={pauseTaskById}
              onResume={handleResume}
              onCancel={cancelTaskById}
              onRemove={removeTaskById}
              onFocus={handleFocus}
            />
          ))}
        </ul>
      )}
      {/* counts 暴露给 header 渲染徽章：App.jsx 通过读 s.tasks 计算或这里通过 store selector 自取 */}
    </div>
  );
}

// 暴露 counts 给 App.jsx 用：保持调用方式一致
export function useTaskCounts() {
  const tasks = useStore((s) => s.tasks || []);
  return useMemo(() => {
    const c = { total: tasks.length, running: 0, paused: 0, interrupted: 0, failed: 0, completed: 0, cancelled: 0 };
    for (const t of tasks) {
      if (c[t.status] !== undefined) c[t.status] += 1;
    }
    return c;
  }, [tasks]);
}