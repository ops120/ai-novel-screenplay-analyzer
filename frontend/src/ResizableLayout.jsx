import React, { useState, useRef, useEffect } from 'react';

export default function ResizableLayout({ left, middle, right }) {
  const containerRef = useRef(null);
  const [leftWidth, setLeftWidth] = useState(0);
  const [middleWidth, setMiddleWidth] = useState(0);
  const [isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // 初始化时根据容器宽度设置默认值
  useEffect(() => {
    if (containerRef.current && !initialized) {
      const rect = containerRef.current.getBoundingClientRect();
      const containerWidth = rect.width;
      
      let initialLeft, initialMiddle;
      
      // 根据容器宽度计算合理的初始宽度
      if (containerWidth < 800) {
        // 小屏幕：使用更小的固定值
        initialLeft = Math.max(150, containerWidth * 0.25);
        initialMiddle = Math.max(200, containerWidth * 0.35);
      } else if (containerWidth < 1200) {
        // 中等屏幕
        initialLeft = 200;
        initialMiddle = 350;
      } else {
        // 大屏幕：左侧 15%，中间 25%，右侧 60%
        initialLeft = Math.min(280, containerWidth * 0.15);
        initialMiddle = Math.min(400, containerWidth * 0.25);
      }
      
      setLeftWidth(initialLeft);
      setMiddleWidth(initialMiddle);
      setInitialized(true);
      
      console.log('ResizableLayout 初始化:', {
        containerWidth,
        containerLeft: rect.left,
        containerRight: rect.right,
        windowWidth: window.innerWidth,
        leftWidth: initialLeft,
        middleWidth: initialMiddle,
        dividerWidth: 16,
        rightWidth: containerWidth - initialLeft - initialMiddle - 16,
        rightPercent: ((containerWidth - initialLeft - initialMiddle - 16) / containerWidth * 100).toFixed(1) + '%'
      });
    }
  }, [initialized]);

  // 窗口大小变化时调整
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && initialized) {
        const rect = containerRef.current.getBoundingClientRect();
        const containerWidth = rect.width;
        const totalFixed = leftWidth + middleWidth + 16;
        
        // 如果固定宽度超过容器宽度的80%，按比例缩小
        if (totalFixed > containerWidth * 0.8) {
          const scale = (containerWidth * 0.8) / totalFixed;
          setLeftWidth(Math.max(200, leftWidth * scale));
          setMiddleWidth(Math.max(300, middleWidth * scale));
          console.log('窗口调整，缩放布局:', { containerWidth, scale });
        }
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [initialized, leftWidth, middleWidth]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const containerWidth = containerRect.width;
      
      if (isDraggingLeft) {
        const newWidth = e.clientX - containerRect.left;
        const minLeft = 150;
        const maxLeft = Math.min(400, containerWidth * 0.4);
        console.log('左侧拖拽:', { mouseX: e.clientX, containerLeft: containerRect.left, newWidth, minLeft, maxLeft, leftWidth });
        if (newWidth >= minLeft && newWidth <= maxLeft) {
          setLeftWidth(newWidth);
        }
      }
      
      if (isDraggingRight) {
        // 计算中间区域宽度：鼠标位置 - 容器左边 - 左侧宽度 - 左侧拖拽条宽度(8px)
        const newWidth = e.clientX - containerRect.left - leftWidth - 8;
        const minMiddle = 200;
        // 确保右侧至少有 300px 空间
        const maxMiddle = Math.max(300, containerWidth - leftWidth - 300 - 16);
        console.log('右侧拖拽:', { 
          mouseX: e.clientX, 
          containerLeft: containerRect.left, 
          containerWidth,
          leftWidth, 
          calculated: e.clientX - containerRect.left - leftWidth - 8,
          newWidth,
          minMiddle,
          maxMiddle,
          middleWidth,
          rightWillBe: containerWidth - leftWidth - newWidth - 16,
          willUpdate: newWidth >= minMiddle && newWidth <= maxMiddle
        });
        if (newWidth >= minMiddle && newWidth <= maxMiddle) {
          setMiddleWidth(newWidth);
        }
      }
    };

    const handleMouseUp = () => {
      console.log('拖拽结束:', { leftWidth, middleWidth });
      setIsDraggingLeft(false);
      setIsDraggingRight(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };

    if (isDraggingLeft || isDraggingRight) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingLeft, isDraggingRight, leftWidth, middleWidth]);

  return (
    <div 
      ref={containerRef} 
      style={{ 
        display: 'flex', 
        flex: 1, 
        overflow: 'hidden',
        background: 'white',
        borderRadius: 16,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
        border: '1px solid rgba(255, 255, 255, 0.18)'
      }}
      onMouseMove={(e) => {
        // 实时显示容器信息
        if (containerRef.current && (isDraggingLeft || isDraggingRight)) {
          const rect = containerRef.current.getBoundingClientRect();
          console.log('容器实时信息:', {
            containerWidth: rect.width,
            leftWidth,
            middleWidth,
            rightCalculated: rect.width - leftWidth - middleWidth - 16
          });
        }
      }}
    >
      {!initialized ? (
        // 初始化中，显示占位
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ color: '#999' }}>加载中...</div>
        </div>
      ) : (
        <>
          {/* 左侧区域 */}
          <div 
            style={{ width: leftWidth, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
            ref={(el) => {
              if (el) {
                const rect = el.getBoundingClientRect();
                console.log('左侧区域尺寸:', { width: rect.width, height: rect.height });
              }
            }}
          >
            {left}
          </div>

      {/* 左侧拖拽条 */}
      <div
        onMouseDown={() => setIsDraggingLeft(true)}
        style={{
          width: 8,
          cursor: 'col-resize',
          background: isDraggingLeft ? '#667eea' : 'transparent',
          transition: 'background 0.2s',
          flexShrink: 0,
          position: 'relative',
          zIndex: 10,
          userSelect: 'none'
        }}
        onMouseEnter={(e) => {
          if (!isDraggingLeft) e.currentTarget.style.background = '#d9d9d9';
        }}
        onMouseLeave={(e) => {
          if (!isDraggingLeft) e.currentTarget.style.background = 'transparent';
        }}
      >
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 24,
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isDraggingLeft ? '#667eea' : '#999',
          borderRadius: 4,
          opacity: 0,
          transition: 'opacity 0.2s',
          pointerEvents: 'none',
          color: '#fff',
          fontSize: 14
        }}>
          ⋮
        </div>
      </div>

      {/* 中间区域 */}
      <div 
        style={{ width: middleWidth, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
        ref={(el) => {
          if (el) {
            const rect = el.getBoundingClientRect();
            console.log('中间区域尺寸:', { width: rect.width, height: rect.height });
          }
        }}
      >
        {middle}
      </div>

      {/* 右侧拖拽条 */}
      <div
        onMouseDown={() => setIsDraggingRight(true)}
        style={{
          width: 8,
          cursor: 'col-resize',
          background: isDraggingRight ? '#667eea' : 'transparent',
          transition: 'background 0.2s',
          flexShrink: 0,
          position: 'relative',
          zIndex: 10,
          userSelect: 'none'
        }}
        onMouseEnter={(e) => {
          if (!isDraggingRight) e.currentTarget.style.background = '#d9d9d9';
        }}
        onMouseLeave={(e) => {
          if (!isDraggingRight) e.currentTarget.style.background = 'transparent';
        }}
      >
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 24,
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isDraggingRight ? '#667eea' : '#999',
          borderRadius: 4,
          opacity: 0,
          transition: 'opacity 0.2s',
          pointerEvents: 'none',
          color: '#fff',
          fontSize: 14
        }}>
          ⋮
        </div>
      </div>

      {/* 右侧区域 */}
      <div 
        style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}
        ref={(el) => {
          if (el) {
            const rect = el.getBoundingClientRect();
            console.log('右侧区域尺寸:', { 
              width: rect.width, 
              height: rect.height,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom
            });
          }
        }}
      >
        {right}
      </div>
        </>
      )}
    </div>
  );
}
