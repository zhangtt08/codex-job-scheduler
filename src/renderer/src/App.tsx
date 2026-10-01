import React, { useCallback, useEffect, useState } from 'react'
import Dashboard from './pages/Dashboard'
import ProjectsPage from './pages/Projects'
import TasksPage from './pages/Tasks'
import LogsPage from './pages/Logs'
import AgentsPage from './pages/Agents'
import TitleBar, { WindowControls } from './TitleBar'
import { api } from './api'
import type { AgentStatus } from '../../shared/types'

type Page = 'dashboard' | 'projects' | 'tasks' | 'logs' | 'agents'

const NAV: Array<{ id: Page; label: string; icon: string }> = [
  { id: 'dashboard', label: '仪表盘', icon: '◱' },
  { id: 'projects', label: '项目', icon: '▤' },
  { id: 'tasks', label: '任务', icon: '◷' },
  { id: 'logs', label: '日志', icon: '≡' },
  { id: 'agents', label: 'Agents', icon: '◈' }
]

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [statuses, setStatuses] = useState<AgentStatus[] | null>(null)

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  useEffect(() => {
    api
      .agentStatuses()
      .then(setStatuses)
      .catch(() => setStatuses([]))
  }, [refreshKey])

  const available = statuses?.filter((s) => s.available).length ?? 0
  const total = statuses?.length ?? 0

  return (
    <div className="shell">
      <div className="shell-body shell-body-top">
        <aside className="sidebar">
          <div className="brand drag-region">
            <span className="brand-mark">◆</span>
            <div>
              <div className="brand-name">Agent 任务调度</div>
              <div className="brand-sub">无人值守执行器</div>
            </div>
            <WindowControls />
          </div>
          <nav>
            {NAV.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            <div className={`codex-dot ${statuses ? (available > 0 ? 'ok' : 'bad') : ''}`} />
            <span>{statuses ? `${available}/${total} 个后端可用` : '正在检测后端…'}</span>
          </div>
        </aside>
        <main className="content">
          <Dashboard onNavigate={setPage} refreshKey={refreshKey} show={page === 'dashboard'} />
          <ProjectsPage refreshKey={refreshKey} show={page === 'projects'} />
          <TasksPage refreshKey={refreshKey} show={page === 'tasks'} />
          <LogsPage refreshKey={refreshKey} show={page === 'logs'} />
          <AgentsPage refreshKey={refreshKey} show={page === 'agents'} onChanged={refresh} />
        </main>
      </div>
    </div>
  )
}
