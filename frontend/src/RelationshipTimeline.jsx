// v26：商用化浅色工作台底部「关系轨迹」面板。
// 严格按 spec §5.6：可折叠 / 没有可造章节数据时使用「关系轨迹」措辞，
// 不伪造章节时间线；当前选中与图谱同步。

import React, { useState, useEffect, useRef } from 'react';

function displayText(value, fallback) {
  return value === null || value === undefined || value === '' ? fallback : value;
}

const VIEW_MODE_LABELS = {
  all: '全部',
  merged: '多次',
  unique: '单次',
};

export default function RelationshipTimeline({
  tracks = [],
  viewMode = 'all',
  onViewModeChange,
  chapterFilter = null,
  chapterOptions = [],
  onChapterChange,
  onSelectNode,
  selectedNodeLabel = '',
  projectName = '',
  updatedAt = '—',
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const timelineRef = useRef(null);
  useEffect(() => {
    const onFsChange = () => {
      const active = timelineRef.current && document.fullscreenElement === timelineRef.current;
      setFullscreen(Boolean(active));
      if (!active && collapsed) setCollapsed(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleFullscreen = async () => {
    if (!timelineRef.current) return;
    try {
      if (document.fullscreenElement === timelineRef.current) {
        await document.exitFullscreen();
      } else if (document.fullscreenEnabled) {
        await timelineRef.current.requestFullscreen();
      }
    } catch (e) {
      console.warn('timeline fullscreen failed', e);
    }
  };
  const hasChapters = chapterOptions.length > 0;
  const useChapterTimeline = hasChapters && chapterFilter;
  const filterChip = chapterFilter
    ? `当前章节：${chapterFilter}`
    : hasChapters
      ? '已识别章节范围 — 选择章节查看聚焦关系轨迹'
      : '尚未识别章节标记 — 显示全部关系轨迹，不伪造章节刻度';
  const workspaceTitle = projectName
    ? `关系演化时间线 · ${projectName}`
    : '关系演化时间线';
  const workspaceSubtitle = hasChapters
    ? `按已识别章节追踪关系变化 · ${tracks.length} 条关系轨迹`
    : `未识别章节标记 · ${tracks.length} 条关系轨迹`;

  return (
    <section
      ref={timelineRef}
      className={`nl-timeline nl-timeline-workspace${collapsed ? ' collapsed' : ''}${fullscreen ? ' fullscreen' : ''}`}
      aria-labelledby="timeline-heading"
    >
      <header className="nl-main-h nl-timeline-workspace-head">
        <div className="nl-main-h-left">
          <h2 id="timeline-heading">{workspaceTitle}</h2>
          <div className="nl-main-subline">{workspaceSubtitle}</div>
        </div>
        <div className="nl-timeline-workspace-actions">
          <span className="nl-tl-ts">最近更新 {updatedAt || '—'}</span>
          <button
            type="button"
            className="nl-pill"
            onClick={toggleFullscreen}
            title={fullscreen ? '退出全屏 (Esc)' : '全屏查看 (T)'}
            aria-label={fullscreen ? '退出全屏' : '全屏查看'}
          >{fullscreen ? '退出全屏' : '全屏'}</button>
          <button
            type="button"
            className="nl-pill"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-controls="nl-timeline-body"
          >{collapsed ? '展开' : '折叠'}</button>
        </div>
      </header>

      {!collapsed && (
        <>
          <div className="nl-toolbar nl-timeline-workspace-toolbar" role="toolbar" aria-label="时间线视图过滤">
            <div className="nl-seg" role="radiogroup" aria-label="关系出现次数">
              {Object.entries(VIEW_MODE_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={viewMode === key}
                  className={viewMode === key ? 'active' : ''}
                  onClick={() => onViewModeChange?.(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            {hasChapters && (
              <div className="nl-range" aria-label="章节过滤">
                <button
                  type="button"
                  className={`nl-pill${chapterFilter === null ? ' active' : ''}`}
                  onClick={() => onChapterChange?.(null)}
                  title="查看全部章节"
                >
                  全部章节
                </button>
                {chapterOptions.slice(0, 6).map((chapter) => (
                  <button
                    key={chapter}
                    type="button"
                    className={`nl-pill${chapterFilter === chapter ? ' active' : ''}`}
                    onClick={() => onChapterChange?.(chapter)}
                    title={`聚焦 ${chapter}`}
                  >
                    {chapter}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="nl-timeline-body" id="nl-timeline-body">
            <div style={{ fontSize: 11, color: '#9299a7', marginBottom: 8 }}>{filterChip}</div>

            {tracks.length === 0 ? (
              <div className="nl-timeline-empty">
                {useChapterTimeline
                  ? `当前章节「${chapterFilter}」下暂无关系轨迹。`
                  : '当前过滤条件下暂无关系轨迹。'}
              </div>
            ) : (
              <ol className="nl-timeline-tracks">
                {tracks.slice(0, 200).map((track) => (
                  <li className="nl-track-row" key={track.key}>
                    <button
                      type="button"
                      onClick={() => onSelectNode?.(track.source.id)}
                      title={`查看 ${track.source.label} 的档案`}
                    >
                      {displayText(track.source.label, '未命名人物')}
                      {track.chapter && (
                        <div className="nl-track-meta">📍 {track.chapter}</div>
                      )}
                    </button>
                    <span>
                      <div className="nl-track-relationship">
                        {displayText(track.label, '关系未标注')}
                        {track.edgeOccurrence > 1 && (
                          <span style={{ marginLeft: 4 }}>×{track.edgeOccurrence}</span>
                        )}
                      </div>
                      <div className="nl-track-arrow" aria-hidden="true">→</div>
                    </span>
                    <button
                      type="button"
                      onClick={() => onSelectNode?.(track.target.id)}
                      title={`查看 ${track.target.label} 的档案`}
                    >
                      {displayText(track.target.label, '未命名人物')}
                      {track.chapter && (
                        <div className="nl-track-meta">📍 {track.chapter}</div>
                      )}
                    </button>
                  </li>
                ))}
                {tracks.length > 200 && (
                  <li style={{ fontSize: 11, color: '#9299a7', padding: '6px 4px' }}>
                    还有 {tracks.length - 200} 条关系轨迹未显示 — 调整上方过滤条件缩小范围。
                  </li>
                )}
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  );
}
