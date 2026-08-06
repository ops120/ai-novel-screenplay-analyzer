// v26：商业化浅色工作台底部「关系轨迹」面板。
// 严格按 spec §5.6：可折叠 / 没有可靠章节数据时使用「关系轨迹」措辞，
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
  const sectionTitle = hasChapters ? '关系轨迹（按章节）' : '关系轨迹';

  return (
    <section
      ref={timelineRef}
      className={`nl-timeline${collapsed ? ' collapsed' : ''}${fullscreen ? ' fullscreen' : ''}`}
      aria-labelledby="timeline-heading"
    >
      <aside className="nl-timeline-head">
        <div className="nl-inspector-kicker">Relationship Timeline</div>
        <h3 id="timeline-heading">关系演化时间线</h3>
        <p>{hasChapters
          ? '把人物关系转折映射回已识别的章节，方便编辑和制片快速定位原文证据。'
          : '当前文本尚未识别章节标记；下方按关系整体轨迹展示，不伪造章节时间线。'}</p>
        <div className="nl-timeline-actions" role="toolbar" aria-label="时间线操作">
          <button
            type="button"
            className="nl-timeline-action-btn"
            onClick={toggleFullscreen}
            title={fullscreen ? '退出全屏 (Esc)' : '全屏查看 (T)'}
            aria-label={fullscreen ? '退出全屏' : '全屏查看'}
          >{fullscreen ? '✕' : '⛶'}</button>
          <button
            type="button"
            className="nl-collapse-toggle"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-controls="nl-timeline-body"
          >{collapsed ? '展开' : '折叠'}</button>
        </div>
      </aside>

      <div className="nl-timeline-body" id="nl-timeline-body">
        <div className="nl-timeline-controls" role="toolbar" aria-label="时间线视图过滤">
          <div className="nl-timeline-chips" role="radiogroup" aria-label="关系出现次数">
            {Object.entries(VIEW_MODE_LABELS).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={viewMode === key}
                className={`nl-chip${viewMode === key ? ' active' : ''}`}
                onClick={() => onViewModeChange?.(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {hasChapters && (
            <div className="nl-timeline-chips" aria-label="章节过滤">
              <button
                type="button"
                className={`nl-chip${chapterFilter === null ? ' active' : ''}`}
                onClick={() => onChapterChange?.(null)}
                title="查看全部章节"
              >
                全部章节
              </button>
              {chapterOptions.slice(0, 6).map((chapter) => (
              <button
                key={chapter}
                type="button"
                className={`nl-chip${chapterFilter === chapter ? ' active' : ''}`}
                onClick={() => onChapterChange?.(chapter)}
                title={`聚焦 ${chapter}`}
              >
                {chapter}
              </button>
            ))}
            </div>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#9299a7' }}>{filterChip}</div>
        
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
                  title={`查看 ${track.source.label} 的洞察`}
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
                  title={`查看 ${track.target.label} 的洞察`}
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
    </section>
  );
}
