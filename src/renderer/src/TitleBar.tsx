import React, { useCallback, useEffect, useState } from 'react'
import { api } from './api'

/**
 * 自绘标题栏：整个条是拖拽区，右侧内嵌最小化/最大化/关闭三键。
 * Windows 下窗口为 frame:false（无系统边框），macOS 用系统红绿灯、只保留拖拽条。
 */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const isMac = navigator.userAgent.includes('Macintosh')

  useEffect(() => {
    const controls = api.windowControls
    if (!controls) return
    let alive = true
    controls
      .isMaximized()
      .then((v) => {
        if (alive) setMaximized(v)
      })
      .catch(() => {})
    const unsubscribe = controls.onMaximizedChange(setMaximized)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 拖拽区内的按钮等已标 no-drag，双击它们不应触发最大化。
    if ((e.target as HTMLElement).closest('button, a, input, select')) return
    void api.windowControls.toggleMaximize().catch(() => {})
  }, [])

  return (
    <div className="titlebar" onDoubleClick={onDoubleClick}>
      <div className="titlebar-title">Agent 任务调度器</div>
      {!isMac && (
        <div className="win-controls">
          <button
            type="button"
            className="win-btn"
            title="最小化"
            onClick={() => void api.windowControls.minimize().catch(() => {})}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn"
            title={maximized ? '向下还原' : '最大化'}
            onClick={() => void api.windowControls.toggleMaximize().catch(() => {})}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="win-btn close"
            title="关闭"
            onClick={() => void api.windowControls.close().catch(() => {})}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
