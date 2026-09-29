import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { EmptyState, Field, Modal } from '../components'
import type { AgentProfile, Project, ProjectInput } from '../../../shared/types'

export default function ProjectsPage({ refreshKey, show }: { refreshKey: number; show: boolean }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [editing, setEditing] = useState<Project | 'new' | null>(null)

  const load = () => api.listProjects().then(setProjects)
  useEffect(() => {
    if (show) load()
  }, [show, refreshKey])

  if (!show) return null

  const remove = async (p: Project) => {
    if (!window.confirm(`删除项目「${p.name}」？该项目下的任务也会一并删除。`)) return
    await api.deleteProject(p.id)
    load()
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>项目</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + 添加项目
        </button>
      </header>

      {projects.length === 0 ? (
        <EmptyState title="还没有项目" hint="项目指向一个本地目录，Codex 将在其中工作。" />
      ) : (
        <section className="panel">
          <ul className="row-list">
            {projects.map((p) => (
              <li key={p.id} className="row">
                <div className="row-main">
                  <div className="row-title">
                    {p.name}
                    {p.is_git_repo ? <span className="chip chip-git">git</span> : null}
                  </div>
                  <div className="row-sub mono">{p.path}</div>
                  {p.default_session_id && <div className="row-sub">会话：{p.default_session_id}</div>}
                  {p.agent_id && <div className="row-sub">默认后端：{p.agent_id}</div>}
                </div>
                <div className="row-actions">
                  <button className="btn btn-ghost" onClick={() => setEditing(p)}>
                    编辑
                  </button>
                  <button className="btn btn-danger-ghost" onClick={() => remove(p)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <ProjectForm
          project={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function ProjectForm({
  project,
  onClose,
  onSaved
}: {
  project: Project | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [path, setPath] = useState(project?.path ?? '')
  const [sessionId, setSessionId] = useState(project?.default_session_id ?? '')
  const [prompt, setPrompt] = useState(project?.default_prompt ?? '')
  const [agentId, setAgentId] = useState(project?.agent_id ?? '')
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .listAgents()
      .then((as) => setAgents(as.filter((a) => a.enabled === 1)))
      .catch(() => setAgents([]))
  }, [])

  const browse = async () => {
    const dir = await api.pickFolder()
    if (dir) {
      setPath(dir)
      if (!name) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }

  const save = async () => {
    if (!name.trim() || !path.trim()) {
      setError('名称和目录为必填项。')
      return
    }
    const input: ProjectInput = {
      name: name.trim(),
      path: path.trim(),
      default_session_id: sessionId.trim() || null,
      default_prompt: prompt.trim() || null,
      agent_id: agentId || null
    }
    if (project) await api.updateProject(project.id, input)
    else await api.createProject(input)
    onSaved()
  }

  return (
    <Modal title={project ? '编辑项目' : '添加项目'} onClose={onClose}>
      <Field label="名称">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Portfolio Website" />
      </Field>
      <Field label="项目目录" hint="Codex 将在这个目录内工作。">
        <div className="input-row">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\projects\portfolio" />
          <button className="btn btn-ghost" onClick={browse}>
            浏览…
          </button>
        </div>
      </Field>
      <Field label="默认 Session ID" hint="可选。任务的「恢复会话」模式会使用它。">
        <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} placeholder="0198…" />
      </Field>
      <Field label="默认 Agent 后端" hint="该项目下新建任务时预选的后端；任务本身还能单独覆盖。">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">（使用全局默认：codex）</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="默认提示词" hint="可选。新建任务时自动填入。">
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={save}>
          保存项目
        </button>
      </div>
    </Modal>
  )
}
