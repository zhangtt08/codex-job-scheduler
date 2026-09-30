# Codex Job Scheduler

**Schedule real coding-agent work on your local projects.** At the time you set, an actual CLI agent (Codex, Claude Code, …) is spawned against your repository and does the task — no mouse/keyboard simulation, no cloud worker, everything runs unattended on your own Windows machine.

> 在指定时间让真实的 CLI agent（Codex / Claude Code 等）在你的本地项目里执行真实开发任务——不做鼠标键盘模拟、不依赖云端，Windows 桌面应用 + 内置 MCP 服务器。

English | [简体中文](./README.zh-CN.md)

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white)

**The problem it solves:** coding CLIs like Codex and Claude Code do great work when you ask — but they can't do work when you *don't* ask. Codex Job Scheduler turns "at 4 PM today, do X in project Y" into a scheduled real execution: saving a task auto-registers a Windows scheduled task, a sleeping machine can be woken up, the agent CLI is spawned at the appointed time, and the process output, final response, exit code and session ID are all captured and logged. It also ships a built-in MCP server, so any MCP-capable agent can schedule jobs for itself in natural language — "remind me to send that message at 4 PM" → scheduled → executed.

## ✨ Features

- **Real agent execution, not GUI automation** — spawns actual CLI processes with your project as the working directory; parses the event stream (Codex JSONL / Claude JSONL / plain text) to capture session ID, final response and exit code.
- **Pluggable agent backends** — presets for `codex` / `claude` / `cursor-agent` / `gemini` / `aider` plus a fully custom template (executable + args template + prompt passing + output parser). Add a new CLI by editing a template, not code.
- **Built-in MCP server (stdio, 10 tools)** — `create_task`, `list_tasks`, `get_run_result`, `run_task_now`, `cancel_task`, … so any MCP client can create, query, run or cancel scheduled jobs in natural language. The MCP server runs as its own process and does not require the desktop app to be open.
- **Exactly-once execution** — the in-app scheduler (20 s tick) and Windows Task Scheduler both fire the same job, and the app may be started multiple times; a cross-process atomic DB claim (`UPDATE … WHERE status='scheduled'`, only one row updated wins) plus a single-instance lock guarantees one execution, no matter how many trigger sources race.
- **Works while the app is closed** — tasks auto-register in Windows Task Scheduler (with a definition-file fallback for restricted environments); `WakeToRun` wakes a sleeping PC; a standalone runner (`node dist-runner/codex-runner.cjs --task N`) runs entirely without Electron.
- **Unattended-friendly options** — auto-retry on usage-quota interruption (up to 10×) and on general failure, a light "quota refresh" nudge 5 h after completion, USB backup + eject on success, and optional shutdown after completion (safety default: MCP-created tasks never shut the machine down).
- **Crash-resistant by design** — SQLite in WAL mode (`busy_timeout=15 s`) shared by three processes; interrupted-run recovery only fires when the owning process is truly gone; `uncaughtException`/`unhandledRejection` handlers and per-stream error listeners keep the app alive; everything lands in `%APPDATA%\CodexJobScheduler\`.
- **UI included** (currently Chinese) — Dashboard / Projects / Tasks / Logs / Agents pages, with real-time output while a task runs.

> **Status:** early stage (v0.2.0), actively developed. The UI is Chinese-only for now. Planned: runner packaged as a standalone `.exe`, Git checkpointing.

## 🚀 Quick Start

**Prerequisites**

- Windows 10/11
- Node.js ≥ 22.5 (the runner and MCP server rely on the built-in `node:sqlite`; the app warns you at task-save time if the scheduled `node.exe` is too old)
- At least one agent CLI installed and authenticated, e.g. [Codex CLI](https://github.com/openai/codex) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

```bash
git clone https://github.com/zhangtt08/codex-job-scheduler.git
cd codex-job-scheduler
npm install
npm run build:all    # desktop app (out/) + runner (dist-runner/) + MCP server (dist-mcp/)
npm run dev          # start the app
```

Then: **Projects → add a folder** (optionally set a default prompt / session / agent backend), **Tasks → new task** (pick project, write the prompt, set date & time, pick the agent) → **save**. The Windows scheduled task is registered automatically (if registration is denied, run the app as administrator and re-save).

At run time: Task Scheduler starts the runner (or the in-app scheduler fires — they are mutually exclusive) → the agent CLI runs → results appear in **Logs** (process log, final response, exit code, changed files).

**Hook an MCP client into it** (Claude Code, Codex, etc.):

```json
{
  "mcpServers": {
    "job-scheduler": {
      "command": "node",
      "args": ["C:\\path\\to\\codex-job-scheduler\\dist-mcp\\mcp-server.cjs"]
    }
  }
}
```

Handy scripts:

```bash
npm run build:runner # rebuild the standalone runner after code changes
npm run build:mcp    # rebuild the MCP server
npm run typecheck    # tsc --noEmit
```

> After changing code you must rebuild: scheduled tasks run `dist-runner/codex-runner.cjs`, MCP clients use `dist-mcp/mcp-server.cjs`, and the desktop app loads `out/`.

## 🏗️ Architecture / How it works

Three processes share one SQLite database and one data directory (`%APPDATA%\CodexJobScheduler\`), and none of them depends on the others being alive:

```
src/
├─ shared/          # shared by all three processes (no electron imports allowed)
│  ├─ db.ts         # node:sqlite data layer: schema, atomic task claim, agent configs
│  ├─ agents.ts     # agent backend abstraction: presets, exe detection, arg templates, output parsers
│  ├─ executor.ts   # agent-agnostic task executor: claim / precheck / spawn / persist / post-actions
│  ├─ scheduler.ts  # Windows Task Scheduler adapter (schtasks + definition-file fallback)
│  ├─ runat.ts      # "run at 16:00" time parsing and description
│  ├─ usb.ts        # USB backup & eject
│  └─ types.ts
├─ main/            # Electron main process: window + tray + IPC + in-app scheduler
├─ preload/         # contextBridge (contextIsolation + sandbox enabled)
├─ renderer/        # React UI (Dashboard / Projects / Tasks / Logs / Agents)
├─ runner/          # standalone runner entry (cli.ts: --task <ID> [--force])
└─ mcp/             # MCP server (stdio / NDJSON, 10 tools)
```

Execution flow:

1. **Save** — task row + Windows scheduled task (`\CodexJobScheduler\Task_<id>`) are created together; deletion cleans up all three landing spots (service registration, fallback file, staged XML), so no ghost tasks linger.
2. **Trigger** — the scheduled task or the in-app scheduler fires; the executor atomically claims the task (`scheduled → preparing`) so exactly one trigger wins, then pre-checks that no live process already runs the same task.
3. **Execute** — the agent CLI is spawned with the arg template (`{cwd}`, `{model}`, `{lastMessageFile}`, `{session}` placeholders; `{model}` elides its preceding flag when empty), stdout is parsed by the backend's parser, and the run is persisted to `logs/<runId>/` (`stdout.jsonl`, `stderr.log`, `final-response.md`).
4. **Aftermath** — optional retry (quota/failure), USB backup, or shutdown, per the task's options.

Manual testing without touching real data:

```bash
npx esbuild src/runner/seed.ts --bundle --platform=node --format=cjs --outfile=dist-runner/seed.cjs
node dist-runner/seed.cjs <some-project-dir>   # create a test project + task
node dist-runner/codex-runner.cjs --task 1     # real agent run
node dist-runner/codex-runner.cjs --task 1 --force   # manual trigger (skips the atomic claim)
echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | node dist-mcp/mcp-server.cjs  # MCP smoke test
```

## 📄 License

[MIT](./LICENSE) © 2026 zhangtt08
