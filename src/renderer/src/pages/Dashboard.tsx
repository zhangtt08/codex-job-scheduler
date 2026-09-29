import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Countdown, EmptyState, StatusBadge, formatDateTime, formatDuration } from '../components'
import type { DashboardData } from '../../../shared/types'

export default function Dashboard({
  onNavigate,
  refreshKey,
  show
}: {
  onNavigate: (p: 'projects' | 'tasks' | 'logs') => void
  refreshKey: number
  show: boolean
}) {
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => {
    if (show) api.dashboard().then(setData)
  }, [show, refreshKey])

  if (!show) return null
  if (!data) return <div className="page">加载中…</div>

  const next = data.nextTask

  return (
    <div className="page">
      <header className="page-head">
        <h1>仪表盘</h1>
        <button className="btn btn-primary" onClick={() => onNavigate('tasks')}>
          + 新建任务
        </button>
      </header>

      {next && next.run_date && next.run_time ? (
        <section className="next-card glass">
          <div className="next-label">下一个任务</div>
          <div className="next-main">
            <div className="next-time">{next.run_time}</div>
            <div className="next-info">
              <div className="next-name">{next.name}</div>
              <div className="next-project">{next.project_name}</div>
              <div className="next-prompt">{next.prompt}</div>
            </div>
            <div className="next-count">
              <Countdown date={next.run_date} time={next.run_time} />
              <span className="next-count-label">后开始</span>
            </div>
          </div>
        </section>
      ) : (
        <section className="next-card next-card-empty">
          <div className="next-label">下一个任务</div>
          <p className="empty-hint">暂无已排期的任务。创建一个任务并设置执行日期和时间。</p>
        </section>
      )}

      <section className="stat-row">
        <StatCard label="已计划" value={data.counts.scheduled} tone="muted" />
        <StatCard label="运行中" value={data.counts.running} tone="running" />
        <StatCard label="已完成" value={data.counts.completed} tone="success" />
        <StatCard label="失败" value={data.counts.failed} tone="failed" />
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>今日任务</h2>
            <button className="link-btn" onClick={() => onNavigate('tasks')}>
              查看全部 →
            </button>
          </div>
          {data.todayTasks.length === 0 ? (
            <EmptyState title="今天没有已排期的任务" />
          ) : (
            <ul className="row-list">
              {data.todayTasks.map((t) => (
                <li key={t.id} className="row">
                  <div>
                    <div className="row-title">
                      {t.run_time ?? '—'} · {t.name}
                    </div>
                    <div className="row-sub">{t.project_name}</div>
                  </div>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>最近运行</h2>
            <button className="link-btn" onClick={() => onNavigate('logs')}>
              查看全部 →
            </button>
          </div>
          {data.recentLogs.length === 0 ? (
            <EmptyState title="还没有运行记录" hint="在任务上使用「立即运行」来试用整个流程。" />
          ) : (
            <ul className="row-list">
              {data.recentLogs.map((log) => (
                <li key={log.id} className="row">
                  <div>
                    <div className="row-title">{log.task_name}</div>
                    <div className="row-sub">
                      {formatDateTime(log.started_at)} · {formatDuration(log.duration_ms)}
                    </div>
                  </div>
                  <StatusBadge status={log.status === 'running' ? 'running' : log.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}
