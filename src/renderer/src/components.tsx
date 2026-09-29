import React, { useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------

export function Modal({
  title,
  onClose,
  children,
  wide
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: '已计划',
  preparing: '准备中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  missed: '已错过',
  success: '成功'
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status] ?? status}</span>
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

/** Live countdown to a run_date + run_time moment, ticks every second. */
export function Countdown({ date, time }: { date: string; time: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const target = new Date(`${date}T${time}:00`).getTime()
  if (Number.isNaN(target)) return null
  let diff = Math.max(0, target - now)
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return <span className="countdown">{`${pad(h)}:${pad(m)}:${pad(s)}`}</span>
}

/** Terminal-style live output viewer with autoscroll. */
export function OutputConsole({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    if (ref.current && stick.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  return (
    <pre
      className="console"
      ref={ref}
      onScroll={() => {
        const el = ref.current!
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {lines.length ? lines.join('\n') : '等待输出…'}
    </pre>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  )
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return `${m} 分 ${s % 60} 秒`
}
