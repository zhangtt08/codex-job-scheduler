import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { EmptyState, Modal, StatusBadge, formatDateTime, formatDuration } from '../components'
import type { ExecutionLog } from '../../../shared/types'

export default function LogsPage({ refreshKey, show }: { refreshKey: number; show: boolean }) {
  const [logs, setLogs] = useState<ExecutionLog[]>([])
  const [detail, setDetail] = useState<ExecutionLog | null>(null)

  useEffect(() => {
    if (show) api.listLogs().then(setLogs)
  }, [show, refreshKey])

  if (!show) return null

  return (
    <div className="page">
      <header className="page-head">
        <h1>日志</h1>
      </header>

      {logs.length === 0 ? (
        <EmptyState title="还没有执行日志" />
      ) : (
        <section className="panel">
          <ul className="row-list">
            {logs.map((log) => (
              <li key={log.id} className="row clickable" onClick={() => setDetail(log)}>
                <div className="row-main">
                  <div className="row-title">
                    #{log.id} {log.task_name}
                  </div>
                  <div className="row-sub">
                    {log.project_name} · 开始 {formatDateTime(log.started_at)} ·{' '}
                    {formatDuration(log.duration_ms)} · 退出码 {log.exit_code ?? '—'}
                  </div>
                </div>
                <StatusBadge status={log.status === 'running' ? 'running' : log.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail && <LogDetail log={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

function LogDetail({ log, onClose }: { log: ExecutionLog; onClose: () => void }) {
  return (
    <Modal title={`运行 #${log.id} — ${log.task_name ?? ''}`} onClose={onClose} wide>
      <div className="run-meta">
        <StatusBadge status={log.status === 'running' ? 'running' : log.status} />
        <span className="row-sub">
          开始 {formatDateTime(log.started_at)} · 结束 {formatDateTime(log.ended_at)} ·{' '}
          {formatDuration(log.duration_ms)} · 退出码 {log.exit_code ?? '—'}
        </span>
      </div>

      {log.final_response && (
        <div className="final-response">
          <h3>最终响应</h3>
          <pre>{log.final_response}</pre>
        </div>
      )}
      {log.changed_files && (
        <div className="changed-files">
          <h3>变更文件</h3>
          <pre>{(JSON.parse(log.changed_files) as string[]).join('\n')}</pre>
        </div>
      )}
      {log.git_diff_summary && (
        <div className="changed-files">
          <h3>Git 差异摘要</h3>
          <pre>{log.git_diff_summary}</pre>
        </div>
      )}
      {log.error_message && (
        <div className="changed-files error-block">
          <h3>错误</h3>
          <pre>{log.error_message}</pre>
        </div>
      )}
      <div className="modal-actions">
        <span className="row-sub mono">
          {log.stdout_path ? `stdout：${log.stdout_path}` : ''}
        </span>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  )
}
