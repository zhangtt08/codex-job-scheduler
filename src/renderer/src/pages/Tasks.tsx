import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { EmptyState, Field, Modal, StatusBadge } from '../components'
import type { AgentProfile, ExecutionLog, Project, Task, TaskInput } from '../../../shared/types'
import { formatDateTime, formatDuration, OutputConsole } from '../components'

export default function TasksPage({ refreshKey, show }: { refreshKey: number; show: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const [running, setRunning] = useState<number | null>(null)

  const load = () => api.listTasks().then(setTasks)
  useEffect(() => {
    if (show) load()
  }, [show, refreshKey])

  // Open the run monitor as soon as any run starts (first log update), so the
  // user watches output from the beginning even before startRun resolves.
  useEffect(() => {
    const off = api.onRunUpdated(({ logId }) => setRunning((prev) => prev ?? logId))
    return off
  }, [])

  if (!show) return null

  const runNow = async (task: Task) => {
    const res = await api.startRun(task.id)
    if (res.success && res.logId) {
      setRunning(res.logId)
      load()
    } else {
      window.alert(`启动失败：${res.error}`)
    }
  }

  const remove = async (task: Task) => {
    if (!window.confirm(`删除任务「${task.name}」？`)) return
    await api.deleteTask(task.id)
    load()
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>任务</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + 新建任务
        </button>
      </header>

      {tasks.length === 0 ? (
        <EmptyState title="还没有任务" hint="先创建一个项目，然后在项目下添加任务。" />
      ) : (
        <section className="panel">
          <ul className="row-list">
            {tasks.map((t) => (
              <li key={t.id} className="row">
                <div className="row-main">
                  <div className="row-title">{t.name}</div>
                  <div className="row-sub">
                    {t.project_name} · {t.effective_agent_id ?? 'codex'} ·{' '}
                    {t.run_date && t.run_time ? `${t.run_date} ${t.run_time}` : '未排期（手动）'} ·{' '}
                    {t.execution_mode === 'resume_session' ? `恢复会话 ${t.session_id?.slice(0, 8)}…` : '新建会话'}
                    {t.quota_retry ? ' · 限额重试' : ''}
                    {t.retry_count > 0 ? ` · 失败重试 ${t.retry_used ?? 0}/${t.retry_count}` : ''}
                    {t.success_followup ? ' · 完成后刷新' : ''}
                    {t.usb_backup ? ' · U 盘备份' : ''}
                    {t.post_action !== 'none' ? ' · 完成后：关机' : ''}
                    {t.wake_enabled ? ' · 唤醒' : ''}{' '}
                  </div>
                </div>
                <div className="row-actions">
                  <StatusBadge status={t.status} />
                  <button className="btn btn-primary" onClick={() => runNow(t)}>
                    ▶ 立即运行
                  </button>
                  <button className="btn btn-ghost" onClick={() => setEditing(t)}>
                    编辑
                  </button>
                  <button className="btn btn-danger-ghost" onClick={() => remove(t)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <TaskForm
          task={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}

      {running !== null && (
        <RunMonitor logId={running} onClose={() => setRunning(null)} onDone={load} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create / edit task
// ---------------------------------------------------------------------------

function TaskForm({ task, onClose, onSaved }: { task: Task | null; onClose: () => void; onSaved: () => void }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState(task?.project_id ?? 0)
  const [name, setName] = useState(task?.name ?? '')
  const [runDate, setRunDate] = useState(task?.run_date ?? '')
  const [runTime, setRunTime] = useState(task?.run_time ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [mode, setMode] = useState(task?.execution_mode ?? 'new_session')
  const [sessionId, setSessionId] = useState(task?.session_id ?? '')
  const [retryCount, setRetryCount] = useState(task?.retry_count ?? 0)
  const [postAction, setPostAction] = useState(task?.post_action ?? 'shutdown')
  const [wake, setWake] = useState(task?.wake_enabled === 1)
  const [quotaRetry, setQuotaRetry] = useState(task?.quota_retry === 1)
  const [successFollowup, setSuccessFollowup] = useState(task?.success_followup === 1)
  const [followupPrompt, setFollowupPrompt] = useState(task?.followup_prompt ?? '')
  const [followupModel, setFollowupModel] = useState(task?.followup_model ?? 'gpt-5.6-luna')
  const [usbBackup, setUsbBackup] = useState(task?.usb_backup === 1)
  const [usbCopySubdir, setUsbCopySubdir] = useState(task?.usb_copy_subdir ?? '')
  // 历史数据里这个字段存过 'D:\codex'，显示时归一成 U 盘上的相对目录名。
  const [usbDestFolder, setUsbDestFolder] = useState(
    (task?.usb_dest_folder ?? 'codex').replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, '') || 'codex'
  )
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [agentId, setAgentId] = useState(task?.agent_id ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.listProjects().then((ps) => {
      setProjects(ps)
      if (!projectId && ps.length) setProjectId(ps[0].id)
    })
    api
      .listAgents()
      .then((as) => setAgents(as.filter((a) => a.enabled === 1)))
      .catch(() => setAgents([]))
  }, [])

  const project = projects.find((p) => p.id === projectId)

  const useDefaultPrompt = () => {
    if (project?.default_prompt) setPrompt(project.default_prompt)
    if (project?.default_session_id) setSessionId(project.default_session_id)
  }

  const save = async () => {
    if (!projectId) return setError('请先创建一个项目。')
    if (!name.trim()) return setError('任务名称为必填项。')
    if (!prompt.trim()) return setError('提示词为必填项。')
    if (mode === 'resume_session' && !sessionId.trim())
      return setError('恢复会话模式必须填写 Session ID。')
    const input: TaskInput = {
      project_id: projectId,
      name: name.trim(),
      run_date: runDate || null,
      run_time: runTime || null,
      prompt: prompt.trim(),
      execution_mode: mode,
      session_id: mode === 'resume_session' ? sessionId.trim() : sessionId.trim() || null,
      retry_count: Number(retryCount) || 0,
      post_action: postAction,
      wake_enabled: wake ? 1 : 0,
      quota_retry: quotaRetry ? 1 : 0,
      followup_prompt: followupPrompt.trim() || null,
      followup_model: followupModel.trim() || 'gpt-5.6-luna',
      success_followup: successFollowup ? 1 : 0,
      usb_backup: usbBackup ? 1 : 0,
      usb_copy_subdir: usbCopySubdir.trim() || null,
      usb_dest_folder: usbDestFolder.trim() || 'codex',
      agent_id: agentId || null
    }
    if (task) {
      const res = await api.updateTask(task.id, input)
      if (res.schedule && !res.schedule.ok) window.alert(res.schedule.message)
    } else {
      const res = await api.createTask(input)
      if (res.schedule && !res.schedule.ok) window.alert(res.schedule.message)
    }
    onSaved()
  }

  return (
    <Modal title={task ? '编辑任务' : '新建任务'} onClose={onClose} wide>
      <div className="form-grid">
        <Field label="任务名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Photography Detail" />
        </Field>
        <Field label="项目">
          <select value={projectId} onChange={(e) => setProjectId(Number(e.target.value))}>
            {projects.length === 0 && <option value={0}>还没有项目</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="执行日期">
          <input type="date" value={runDate ?? ''} onChange={(e) => setRunDate(e.target.value)} />
        </Field>
        <Field label="执行时间">
          <input type="time" value={runTime ?? ''} onChange={(e) => setRunTime(e.target.value)} />
        </Field>
        <Field
          label="执行 Agent"
          hint={
            project?.agent_id
              ? `留空 = 用项目默认后端（${project.agent_id}）。`
              : '留空 = 用项目的默认后端（未设置时为 codex）。'
          }
        >
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">（用项目默认）</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="提示词（Prompt）" hint={project ? `项目目录：${project.path}` : undefined}>
        <textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="继续完成 Photography Detail 页面，并测试现有功能。"
        />
      </Field>
      {project?.default_prompt && (
        <button className="link-btn" onClick={useDefaultPrompt}>
          使用项目默认值 →
        </button>
      )}

      <div className="form-grid">
        <Field label="执行模式">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'new_session' | 'resume_session')}>
            <option value="new_session">新建会话</option>
            <option value="resume_session">恢复会话</option>
          </select>
        </Field>
        <Field label="Session ID" hint={mode === 'resume_session' ? '必填——将精确恢复此会话，不会恢复到其他项目。' : '可选。'}>
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            disabled={mode !== 'resume_session' && !sessionId}
            placeholder="0198…"
          />
        </Field>
        <Field label="失败重试次数" hint="执行失败（非限额原因）后 2 分钟自动重跑，最多这么多次；任务成功后计数归零。">
          <input
            type="number"
            min={0}
            max={5}
            value={retryCount}
            onChange={(e) => setRetryCount(Number(e.target.value))}
          />
        </Field>
        <Field
          label="完成后动作"
          hint="项目做完（Codex 回答完提示词）后执行。默认「关机」；若开启限额重试/失败重试/完成刷新，会先完成后续再关机；刷新成功确认后自动关机。"
        >
          <select value={postAction} onChange={(e) => setPostAction(e.target.value as 'none' | 'shutdown')}>
            <option value="none">无操作</option>
            <option value="shutdown">关机</option>
          </select>
        </Field>
      </div>

      <label className="check-field">
        <input type="checkbox" checked={quotaRetry} onChange={(e) => setQuotaRetry(e.target.checked)} />
        限额恢复后自动重试
        <span className="field-hint">
          （任务因用量限额中断 = 项目没做完：自动重排到恢复时间约 2 分钟后，继续用原任务提示词接着做，最多重试 10 次）
        </span>
      </label>

      <label className="check-field">
        <input type="checkbox" checked={successFollowup} onChange={(e) => setSuccessFollowup(e.target.checked)} />
        任务完成后 5 小时自动发送刷新消息
        <span className="field-hint">
          （项目做完后开启下一个限额窗口；刷新消息回答成功 = 限额已往后延续 5 小时 → 自动关机收尾。只安排一次）
        </span>
      </label>

      <Field label="刷新提示词（可选）" hint="「完成后 5 小时刷新」发送的内容；留空则默认询问当前中国北京时间和 5 小时后是什么时间。">
        <textarea
          rows={2}
          value={followupPrompt}
          onChange={(e) => setFollowupPrompt(e.target.value)}
          placeholder="例：请告诉我现在的中国北京时间，以及 5 小时后是什么时间。"
        />
      </Field>

      <Field label="刷新使用模型" hint="刷新消息用最低档模型省额度（继续任务始终用会话当前模型，不受影响）。">
        <input
          value={followupModel}
          onChange={(e) => setFollowupModel(e.target.value)}
          placeholder="gpt-5.6-luna"
        />
      </Field>

      <label className="check-field">
        <input type="checkbox" checked={usbBackup} onChange={(e) => setUsbBackup(e.target.checked)} />
        项目完成后自动备份到 U 盘
        <span className="field-hint">
          （成功后拷贝最新项目文件到 U 盘并自动弹出；自动排除 node_modules/.git/tmp；未插 U 盘时等 1 分钟，仍未插入则跳过并记录）
        </span>
      </label>

      <div className="form-grid">
        <Field label="备份子目录（可选）" hint="只拷贝项目根下这个子目录（如 outputs/ztt-home-index）；留空 = 拷贝整个项目目录。">
          <input
            value={usbCopySubdir}
            onChange={(e) => setUsbCopySubdir(e.target.value)}
            placeholder="outputs/ztt-home-index"
          />
        </Field>
        <Field label="U 盘存放目录" hint="U 盘根目录下的文件夹名，可用子路径；留空 = codex。">
          <input value={usbDestFolder} onChange={(e) => setUsbDestFolder(e.target.value)} placeholder="codex" />
        </Field>
      </div>

      <label className="check-field">
        <input type="checkbox" checked={wake} onChange={(e) => setWake(e.target.checked)} />
        唤醒计算机以执行此任务 <span className="field-hint">（写入 Windows 任务计划程序的 WakeToRun）</span>
      </label>

      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={save}>
          保存任务
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Live run monitor
// ---------------------------------------------------------------------------

export function RunMonitor({
  logId,
  onClose,
  onDone
}: {
  logId: number
  onClose: () => void
  onDone?: () => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [log, setLog] = useState<ExecutionLog | null>(null)
  const [finished, setFinished] = useState(false)
  const doneRef = useRef(false)

  useEffect(() => {
    api.getLog(logId).then((l) => {
      setLog(l)
      if (l && l.status !== 'running') setFinished(true)
    })
    const offEvent = api.onRunEvent((e) => {
      if (e.logId !== logId) return
      setLines((prev) => [...prev.slice(-2000), e.line])
    })
    const offUpdated = api.onRunUpdated(async ({ logId: id }) => {
      if (id === logId) setLog(await api.getLog(logId))
    })
    const offFinished = api.onRunFinished(async (res) => {
      if (res.logId !== logId || doneRef.current) return
      doneRef.current = true
      setLog(await api.getLog(logId))
      setFinished(true)
      onDone?.()
    })
    return () => {
      offEvent()
      offUpdated()
      offFinished()
    }
  }, [logId])

  const cancel = async () => {
    await api.cancelRun(logId)
  }

  // log 还没加载回来时按"运行中"处理，否则取消按钮会闪一下才出现。
  const running = !finished

  return (
    <Modal title={`运行 #${logId} — ${log?.task_name ?? ''}`} onClose={onClose} wide>
      <div className="run-meta">
        <StatusBadge status={finished ? (log?.status ?? 'failed') : (log?.status ?? 'running')} />
        {log && (
          <span className="row-sub">
            退出码 {log.exit_code ?? '—'} · {formatDuration(log.duration_ms)}
            {log.session_id ? ` · 会话 ${log.session_id}` : ''}
          </span>
        )}
        <div className="spacer" />
        {running && (
          <button className="btn btn-danger-ghost" onClick={cancel}>
            ■ 取消运行
          </button>
        )}
      </div>
      <OutputConsole lines={lines} />
      {finished && log?.final_response && (
        <div className="final-response">
          <h3>最终响应</h3>
          <pre>{log.final_response}</pre>
        </div>
      )}
      {finished && log?.changed_files && (
        <div className="changed-files">
          <h3>变更文件</h3>
          <pre>{(JSON.parse(log.changed_files) as string[]).join('\n')}</pre>
        </div>
      )}
      <div className="modal-actions">
        <span className="row-sub">{log ? `开始时间 ${formatDateTime(log.started_at)}` : ''}</span>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  )
}
