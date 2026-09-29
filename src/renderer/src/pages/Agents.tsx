import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { EmptyState, Field, Modal } from '../components'
import type { AgentInput, AgentProfile, AgentStatus, OutputParser, PromptVia } from '../../../shared/types'

export default function AgentsPage({
  refreshKey,
  show,
  onChanged
}: {
  refreshKey: number
  show: boolean
  onChanged: () => void
}) {
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<AgentProfile | 'new' | null>(null)

  const load = async () => {
    const list = await api.listAgents()
    setAgents(list)
    api
      .agentStatuses()
      .then((ss) => setStatuses(Object.fromEntries(ss.map((s) => [s.id, s]))))
      .catch(() => setStatuses({}))
  }

  useEffect(() => {
    if (show) void load()
  }, [show, refreshKey])

  if (!show) return null

  const probe = async (id: string) => {
    setProbing((p) => ({ ...p, [id]: true }))
    try {
      const status = await api.probeAgent(id)
      setStatuses((prev) => ({ ...prev, [id]: status }))
    } catch (err) {
      setStatuses((prev) => ({
        ...prev,
        [id]: {
          id,
          label: prev[id]?.label ?? id,
          resolvedBin: null,
          available: false,
          version: null,
          error: (err as Error).message
        }
      }))
    } finally {
      setProbing((p) => ({ ...p, [id]: false }))
    }
  }

  const remove = async (agent: AgentProfile) => {
    if (!window.confirm(`删除后端「${agent.label}」？引用它的任务会回落到项目的默认后端。`)) return
    try {
      await api.deleteAgent(agent.id)
      onChanged()
      void load()
    } catch (err) {
      window.alert((err as Error).message)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Agents</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + 新增后端
        </button>
      </header>

      <p className="field-hint" style={{ marginTop: -8 }}>
        每个后端就是一条「可执行文件 + 参数模板」。内置后端可直接改参数；接新 CLI（zcode、windsurf、自研脚本等）新建一条即可，
        不需要改代码。参数模板里的占位符：<code className="mono">{'{cwd}'}</code> 项目目录、
        <code className="mono">{'{model}'}</code> 模型、<code className="mono">{'{lastMessageFile}'}</code> 最终响应落盘、
        <code className="mono">{'{session}'}</code> 会话 ID。
      </p>

      {agents.length === 0 ? (
        <EmptyState title="还没有可用的后端" />
      ) : (
        <section className="panel">
          <ul className="row-list">
            {agents.map((a) => {
              const st = statuses[a.id]
              return (
                <li key={a.id} className="row">
                  <div className="row-main">
                    <div className="row-title">
                      {a.label}
                      <span className="chip chip-git">{a.id}</span>
                      {a.builtin === 1 ? <span className="chip">内置</span> : null}
                      {a.enabled !== 1 ? <span className="chip">已停用</span> : null}
                    </div>
                    <div className="row-sub mono">
                      {st?.resolvedBin || a.bin || '（自动探测）'}
                      {st?.version ? ` · ${st.version}` : ''}
                    </div>
                    <div className="row-sub">
                      {st === undefined
                        ? '未探测'
                        : st.available
                          ? '可执行文件已就绪'
                          : st.error || '不可用'}
                    </div>
                  </div>
                  <div className="row-actions">
                    {st ? (
                      <span className={`badge badge-${st.available ? 'completed' : 'failed'}`}>
                        {st.available ? '可用' : '不可用'}
                      </span>
                    ) : null}
                    <button className="btn btn-ghost" onClick={() => probe(a.id)} disabled={probing[a.id]}>
                      {probing[a.id] ? '检测中…' : '检测'}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setEditing(a)}>
                      编辑
                    </button>
                    {a.builtin === 1 ? null : (
                      <button className="btn btn-danger-ghost" onClick={() => remove(a)}>
                        删除
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {editing && (
        <AgentForm
          agent={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            onChanged()
            void load()
          }}
        />
      )}
    </div>
  )
}

const argsToText = (args: string[]): string => args.join('\n')

/** 一行一个参数；忽略空行与以 # 开头的注释行。 */
const textToArgs = (text: string): string[] =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))

function AgentForm({
  agent,
  onClose,
  onSaved
}: {
  agent: AgentProfile | null
  onClose: () => void
  onSaved: () => void
}) {
  const [id, setId] = useState(agent?.id ?? '')
  const [label, setLabel] = useState(agent?.label ?? '')
  const [bin, setBin] = useState(agent?.bin ?? '')
  const [promptVia, setPromptVia] = useState<PromptVia>(agent?.prompt_via ?? 'stdin')
  const [parser, setParser] = useState<OutputParser>(agent?.parser ?? 'plain')
  const [newArgs, setNewArgs] = useState(argsToText(agent?.new_args ?? []))
  const [resumeArgs, setResumeArgs] = useState(argsToText(agent?.resume_args ?? []))
  const [envText, setEnvText] = useState(
    agent?.env ? Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
  )
  const [enabled, setEnabled] = useState(agent ? agent.enabled === 1 : true)
  const [notes, setNotes] = useState(agent?.notes ?? '')
  const [error, setError] = useState<string | null>(null)

  const parseEnvText = (): Record<string, string> | null => {
    const out: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq <= 0) continue
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    return Object.keys(out).length ? out : null
  }

  const save = async () => {
    if (!label.trim()) return setError('显示名称为必填项。')
    const input: AgentInput = {
      label: label.trim(),
      bin: bin.trim(),
      new_args: textToArgs(newArgs),
      resume_args: textToArgs(resumeArgs),
      prompt_via: promptVia,
      parser,
      env: parseEnvText(),
      enabled: enabled ? 1 : 0,
      notes: notes.trim() || null
    }
    if (!agent) input.id = id.trim() || undefined
    try {
      if (agent) await api.updateAgent(agent.id, input)
      else await api.createAgent(input)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Modal title={agent ? `编辑后端 — ${agent.label}` : '新增后端'} onClose={onClose} wide>
      <div className="form-grid">
        <Field label="显示名称">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Claude Code" />
        </Field>
        <Field label="标识 ID" hint={agent ? '创建后不可修改。' : '留空自动生成。'}>
          <input value={id} onChange={(e) => setId(e.target.value)} disabled={!!agent} placeholder="claude" />
        </Field>
      </div>

      <Field
        label="可执行文件"
        hint="绝对路径，或已加入 PATH 的命令名。留空则按 ID 自动探测（codex / claude 有内置规则）。"
      >
        <input value={bin} onChange={(e) => setBin(e.target.value)} placeholder="C:\tools\my-agent.exe" />
      </Field>

      <div className="form-grid">
        <Field label="提示词传递方式" hint="stdin = 管道输入（推荐）；arg = 作为最后一个参数追加。">
          <select value={promptVia} onChange={(e) => setPromptVia(e.target.value as PromptVia)}>
            <option value="stdin">stdin（管道）</option>
            <option value="arg">arg（追加为参数）</option>
          </select>
        </Field>
        <Field
          label="输出解析方式"
          hint="jsonl = Codex 风格事件流；claude-jsonl = Claude Code 的 stream-json；plain = 纯文本，整段作为响应。"
        >
          <select value={parser} onChange={(e) => setParser(e.target.value as OutputParser)}>
            <option value="codex-jsonl">codex-jsonl</option>
            <option value="claude-jsonl">claude-jsonl</option>
            <option value="plain">plain</option>
          </select>
        </Field>
      </div>

      <Field
        label="新建会话参数（一行一个）"
        hint="占位符 {cwd} {model} {lastMessageFile}。{model} 这类「纯占位符」取空值时会连同前一个 flag 一起省略。"
      >
        <textarea
          rows={7}
          value={newArgs}
          onChange={(e) => setNewArgs(e.target.value)}
          placeholder={'exec\n--json\n--cd\n{cwd}'}
        />
      </Field>

      <Field label="恢复会话参数（一行一个）" hint="用 {session} 指代会话 ID。留空表示该后端不支持恢复会话。">
        <textarea
          rows={5}
          value={resumeArgs}
          onChange={(e) => setResumeArgs(e.target.value)}
          placeholder={'exec\nresume\n--json\n{session}'}
        />
      </Field>

      <Field label="附加环境变量（一行一个 KEY=VALUE）" hint="可选。例如给某个后端单独指定 API 端点。">
        <textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="MY_VAR=value" />
      </Field>

      <label className="check-field">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用此后端 <span className="field-hint">（停用后已指向它的任务会执行失败，请先改选）</span>
      </label>

      <Field label="备注" hint="给自己看的说明，比如参数来源或注意事项。">
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={save}>
          保存后端
        </button>
      </div>
    </Modal>
  )
}
