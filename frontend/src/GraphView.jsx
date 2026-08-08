import React, { useEffect, useRef, useState } from 'react';
import { Graph } from '@antv/g6';
import { useStore } from './store.js';
import { truncateLabelForLines } from './edgeLabelTruncate.js';

export default function GraphView({ nodes, edges, edgeLabelLines = 1, onSelectNode }) {
  const containerRef = useRef(null);
  const wrapperRef = useRef(null); // v2.4：观察外层包装（永远挂载），不受条件渲染影响
  const graphRef = useRef(null);
  const [isRendering, setIsRendering] = useState(false);
  const isLoadingProject = useStore(state => state.isLoadingProject);
  const currentProjectId = useStore(state => state.currentProjectId);
  const draggedPositionsRef = useRef(new Map());
  const lastProjectIdRef = useRef(null);

  // 格式化图数据
  const formatGraphData = (nodeList, edgeList, lines) => {
    const nodeIds = new Set(nodeList.map(n => String(n.id)));
    const validEdges = edgeList.filter(e => {
      return nodeIds.has(String(e.source)) && nodeIds.has(String(e.target));
    });

    return {
      nodes: nodeList.map(n => {
        const saved = draggedPositionsRef.current.get(String(n.id));
        const nodeModel = {
          id: String(n.id),
          label: n.label,
          style: {
            fill: '#e6f7ff',
            stroke: '#4D6BFE',
            lineWidth: 2,
          },
          labelCfg: {
            style: { fill: '#1a1a1a', fontSize: 14 }
          }
        };
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          nodeModel.x = saved.x;
          nodeModel.y = saved.y;
          nodeModel.fx = saved.x;
          nodeModel.fy = saved.y;
        }
        return nodeModel;
      }),
      edges: validEdges.map(e => {
        const rawLabel = e.label || '';
        const displayLabel = truncateLabelForLines(rawLabel, lines);
        const isComplex = rawLabel.includes(' → ');
        const occurrenceNum = Number(e.occurrence);
        const isMultiple = Number.isFinite(occurrenceNum) && occurrenceNum > 1;
        const isHot = isComplex || isMultiple; // 多次出现或复杂关系 → 红色加粗
        const multiLine = lines > 1;
        return {
          source: String(e.source),
          target: String(e.target),
          label: displayLabel,
          labelTitle: rawLabel, // 原始标签备用
          style: {
            stroke: isHot ? '#ff6b6b' : '#bbb',
            lineWidth: isHot ? 3 : 1.5,
            endArrow: {
              path: 'M 0,0 L 6,3 L 6,-3 Z',
              fill: isHot ? '#ff6b6b' : '#bbb',
            },
          },
          labelCfg: {
            autoRotate: !multiLine,
            style: {
              fill: isComplex ? '#c92a2a' : '#555',
              fontSize: isComplex ? 13 : 12,
              fontWeight: isComplex ? 'bold' : 'normal',
              wordWrap: multiLine,
              maxWidth: multiLine ? 120 : undefined,
              background: {
                fill: '#fff',
                padding: [2, 4, 2, 4],
                radius: 2,
              }
            }
          }
        };
      })
    };
  };

  // 主渲染 effect
  useEffect(() => {
    if (!containerRef.current) return;
    if (nodes.length === 0) {
      if (graphRef.current) {
        graphRef.current.clear();
      }
      return;
    }

    setIsRendering(true);

    requestAnimationFrame(() => {
      try {
        if (lastProjectIdRef.current !== currentProjectId) {
          draggedPositionsRef.current.clear();
          lastProjectIdRef.current = currentProjectId;
        }
        const graphData = formatGraphData(nodes, edges, edgeLabelLines);

        // 销毁旧实例
        if (graphRef.current) {
          try { graphRef.current.destroy(); } catch {}
          graphRef.current = null;
        }

        // 布局选择
        const layoutConfig = nodes.length > 50 ? {
          type: 'circular',
          radius: 200,
        } : {
          type: 'force',
          linkDistance: 150,
          nodeStrength: -150,
          edgeStrength: 0.2,
          preventOverlap: true,
          nodeSize: 60,
          maxIteration: 200,
        };

        graphRef.current = new Graph({
          container: containerRef.current,
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
          fitView: true,
          fitViewPadding: 50,
          modes: {
            default: ['drag-canvas', 'zoom-canvas', 'drag-node'],
          },
          layout: layoutConfig,
          defaultNode: {
            size: 60,
            style: { fill: '#e6f7ff', stroke: '#4D6BFE', lineWidth: 2 },
            labelCfg: { style: { fill: '#1a1a1a', fontSize: 14 } }
          },
          defaultEdge: {
            style: {
              stroke: '#bbb', lineWidth: 1.5,
              endArrow: { path: 'M 0,0 L 6,3 L 6,-3 Z', fill: '#bbb' },
            },
            labelCfg: {
              autoRotate: true,
              style: { fill: '#555', fontSize: 12 }
            }
          },
        });

        // 节点点击事件
        graphRef.current.on('node:click', (evt) => {
          const nodeId = evt.item?.getModel()?.id;
          if (nodeId && onSelectNode) onSelectNode(nodeId);
        });

        // 拖拽结束：记忆位置并固定 fx/fy，force 布局不再拉回，图重建后也能恢复
        graphRef.current.on('dragnodeend', (evt) => {
          const item = evt?.items?.[0] || evt?.targetItem;
          const model = item?.getModel?.();
          if (!model || !Number.isFinite(model.x) || !Number.isFinite(model.y)) return;
          draggedPositionsRef.current.set(String(model.id), { x: model.x, y: model.y });
          model.fx = model.x;
          model.fy = model.y;
          try {
            const layoutMethod = graphRef.current.get('layoutController')?.layoutMethods?.[0];
            layoutMethod?.forceSimulation?.stop?.();
          } catch {}
        });

        graphRef.current.data(graphData);
        graphRef.current.render();
        setIsRendering(false);
      } catch (error) {
        console.error('Graph 操作失败:', error);
        setIsRendering(false);
      }
    });
  }, [nodes, edges, edgeLabelLines]);

  // 边标签行数切换（原地更新，不重建图）
  useEffect(() => {
    if (!graphRef.current) return;
    const graph = graphRef.current;
    const graphEdges = graph.getEdges();
    if (!graphEdges?.length) return;

    graphEdges.forEach(edge => {
      const model = edge.getModel();
      const rawLabel = model.labelTitle || model.label || '';
      const displayLabel = truncateLabelForLines(rawLabel, edgeLabelLines);
      const multiLine = edgeLabelLines > 1;
      try {
        edge.update({
          label: displayLabel,
          labelCfg: {
            autoRotate: !multiLine,
            style: {
              wordWrap: multiLine,
              maxWidth: multiLine ? 120 : undefined,
            }
          }
        });
      } catch {}
    });
  }, [edgeLabelLines]);

  // 响应式（v2.4：用 ResizeObserver 监听外层 wrapper，覆盖浏览器窗口缩放 + focus / 抽屉切换的 CSS 容器变化）
  // 注意：观察 wrapperRef（永远挂载），不要观察 containerRef（条件渲染，挂载时序不可靠）
  useEffect(() => {
    if (!wrapperRef.current) return undefined;
    const el = wrapperRef.current;
    let rafId = null;
    let lastW = 0;
    let lastH = 0;
    const apply = () => {
      rafId = null;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!graphRef.current) return;
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      graphRef.current.changeSize(w, h);
      graphRef.current.fitView(50);
    };
    const observer = new ResizeObserver(() => {
      // requestAnimationFrame 节流：每帧最多一次，规避 focus 切换瞬间多次回调
      if (rafId !== null) return;
      rafId = requestAnimationFrame(apply);
    });
    observer.observe(el);
    // 立即触发一次，处理初次挂载后容器尺寸就绪
    apply();
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // 卸载销毁
  useEffect(() => {
    return () => {
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, []);

  return (
    <div ref={wrapperRef} style={{ width: '100%', height: '100%', position: 'relative', background: 'var(--surface-alt, #fafafa)' }}>
      {isLoadingProject ? (
        <div className="nl-loading" style={{ height: '100%' }}>
          <div className="nl-spinner" />
          <span>正在加载卷宗数据…</span>
        </div>
      ) : nodes.length === 0 ? (
        // v2.4：空态铺满 — 虚线网格背景 + 居中引导卡片，避免大片空白
        <div className="nl-graph-canvas-bg">
          <div className="nl-graph-canvas-grid" aria-hidden="true" />
          <div className="nl-graph-placeholder">
            <div className="nl-graph-placeholder-kicker">小说剧本智能分析工作台</div>
            <div className="nl-graph-placeholder-icon" aria-hidden="true">🗺️</div>
            <h3>从一份原文开始建立共同理解</h3>
            <p>打开项目库，导入小说或剧本，系统会按章节整理人物关系与演化脉络。</p>
            <span className="nl-graph-placeholder-note">支持立项分析 · 出版审稿 · 改编准备</span>
          </div>
        </div>
      ) : (
        <>
          {/* 节点少时也保留网格背景（弱化），增强"空间被填满"的感受 */}
          <div className="nl-graph-canvas-grid nl-graph-canvas-grid--soft" aria-hidden="true" />
          {isRendering && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              background: 'rgba(255,255,255,0.95)', padding: '16px 28px',
              borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 10,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div className="nl-spinner" />
              <span style={{ fontSize: 14, color: '#666' }}>正在渲染图谱 ({nodes.length} 节点)…</span>
            </div>
          )}
          <div ref={containerRef} style={{ width: '100%', height: '100%', minHeight: 400 }} />
        </>
      )}
    </div>
  );
}
