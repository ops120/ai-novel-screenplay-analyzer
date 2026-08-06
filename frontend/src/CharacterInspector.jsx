// v26：商业化浅色工作台右侧「人物洞察」面板。
// 严格按 spec §5.5：人物摘要 / 直接关系数 / 关系转折数 / 核心度 / 关键关系变化（带证据）。
// - 每条变化必须来自真实数据；无证据时显式标注「暂无可追溯证据」。
// - 「询问这个人物或关系」框不提供：第一阶段无 LLM 问答能力，不得伪装可用。

import React from 'react';
import { buildCharacterInsights } from './narrativeCover';

const PRIMARY_BLUE = '#4D6BFE';

function safeText(value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : value;
}

function avatarText(label) {
  if (!label) return '人';
  // 中文取首字；英文取首字母
  const trimmed = String(label).trim();
  return trimmed ? trimmed[0] : '人';
}

export default function CharacterInspector({ profile, nodes = [], edges = [] }) {
  const insights = buildCharacterInsights(profile || null, edges || [], nodes || []);

  if (!insights) {
    return (
      <section className="nl-inspector" aria-labelledby="inspector-heading">
        <header className="nl-inspector-head">
          <div>
            <div className="nl-inspector-kicker">STORY INTELLIGENCE</div>
            <h2 className="nl-inspector-title" id="inspector-heading">人物洞察</h2>
          </div>
        </header>
        <div className="nl-inspector-body">
          <p className="nl-inspector-empty">
            从图谱或轨迹中选择人物，查看人物档案与已记录的关系证据。
          </p>
        </div>
      </section>
    );
  }

  const label = safeText(insights.label, '未命名人物');
  return (
    <section className="nl-inspector" aria-labelledby="inspector-heading">
      <header className="nl-inspector-head">
        <div style={{ minWidth: 0 }}>
          <div className="nl-inspector-kicker">STORY INTELLIGENCE</div>
          <h2 className="nl-inspector-title" id="inspector-heading">人物洞察</h2>
        </div>
      </header>
      <div className="nl-inspector-body">
        <div className="nl-person">
          <div className="nl-person-row">
            <div className="nl-person-avatar" aria-hidden="true">{avatarText(label)}</div>
            <div style={{ minWidth: 0 }}>
              <h3 className="nl-person-name">{label}</h3>
              <div className="nl-person-sub">{insights.summary || '尚未记录登场信息'}</div>
            </div>
          </div>
          {insights.summary && (
            <p className="nl-person-summary">
              来自现有图谱数据，仅显示已记录的人物与关系变化，不代替模型推断结论。
            </p>
          )}
        </div>

        <div className="nl-signal-row" role="group" aria-label="人物关键指标">
          <div className="nl-signal">
            <span className="nl-signal-label">直接关系</span>
            <b>{insights.directRelationCount}</b>
          </div>
          <div className="nl-signal">
            <span className="nl-signal-label">关系转折</span>
            <b>{insights.turningPointCount}</b>
          </div>
          <div className="nl-signal">
            <span className="nl-signal-label">核心度</span>
            <b>{insights.corePercent}%</b>
          </div>
        </div>

        <div className="nl-inspector-section">
          <div className="nl-inspector-section-head">
            <span>关键关系变化</span>
            <span style={{ color: '#9299a7', fontWeight: 400 }}>来自图谱数据</span>
          </div>
          {insights.keyChanges.length === 0 ? (
            <div style={{ fontSize: 12, color: '#9299a7', padding: '8px 0' }}>
              {insights.directRelationCount === 0
                ? '当前人物暂无已记录的关系，暂无关系变化可总结。'
                : '现有图谱数据中暂未出现「同一人物不同关系」的变化记录。'}
            </div>
          ) : (
            insights.keyChanges.map((change, idx) => {
              const cls = `nl-change${change.noEvidence ? ' no-evidence' : ''}`;
              const evidence = change.evidenceChapters.length > 0
                ? `证据：${change.evidenceChapters.join('、')}`
                : '暂无可追溯证据';
              return (
                <div className={cls} key={`${change.otherId}-${idx}`}>
                  <b>{change.otherLabel} · {change.fromLabel} → {change.toLabel}</b>
                  <p>
                    关系方向从「{change.fromLabel}」转为「{change.toLabel}」，
                    {change.noEvidence
                      ? '现有图谱未记录可追溯的章节证据。'
                      : `可在 ${change.evidenceChapters.join(' / ')} 的关系痕迹中复核。`}
                  </p>
                  <small style={{ color: change.noEvidence ? '#9299a7' : '#7488e8' }}>
                    {evidence}
                  </small>
                </div>
              );
            })
          )}
        </div>

        {/*
          spec §5.5：「询问这个人物或关系」仅在真实问答能力接入后启用；第一阶段隐藏。
          故意不渲染任何可见的伪输入框，避免暗示存在 LLM 问答。
        */}
        <div style={{ padding: '10px 16px 16px', fontSize: 11, color: '#9299a7' }}>
          数据仅来自当前项目的分析结果；尚无多轮问答能力。
        </div>
      </div>
    </section>
  );
}

// 导出两个常量供 App 标题或工具栏使用（避免在多处硬编码）
export const INSPECTOR_PRIMARY = PRIMARY_BLUE;
