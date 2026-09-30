# Agent 任务调度器（Agent Job Scheduler）

English | **简体中文**（[README.md](./README.md)）

Windows 桌面应用：在指定时间对指定本地项目执行真实开发任务，**由可配置的 CLI agent 后端执行**（Codex / Claude Code / 任意 CLI）。不使用鼠标/键盘模拟。

对外提供 **MCP 服务器**：任何支持 MCP 的 agent 都能用自然语言建任务——「今天下午四点提醒我发那条消息」→ 自动排期 → 到点执行。

## 当前状态

- ✅ 架构：Electron + React + TypeScript + Vite（electron-vite）+ SQLite（`node:sqlite`，零原生编译）
- ✅ 数据模型：`agents` / `projects` / `tasks` / `execution_logs`
- ✅ **多 agent 后端**：内置 codex / claude / cursor-agent / gemini / aider 预设 + 完全自定义（改参数模板即可接新 CLI，不用改代码）
- ✅ **MCP 服务器**（stdio）：10 个工具，让 agent 直接建/查/取消任务
- ✅ UI（中文）：仪表盘 / 项目 / 任务 / 日志 / Agents
- ✅ 立即运行（实时输出、事件流解析、最终响应、退出码、会话 ID 捕获）
- ✅ 独立 Runner：`node dist-runner/codex-runner.cjs --task <ID> [--force]`，脱离 Electron 运行
- ✅ Windows 任务计划适配器：任务保存时自动注册（支持 WakeToRun 唤醒）
- ✅ 应用内准点调度：应用开着时每 20 秒检查，不依赖计划服务
- ✅ 限额自动重试、失败自动重试、成功后 5 小时刷新、U 盘备份+弹出、完成后关机
- ✅ 稳定性加固（见下）
- ⏳ 待办：账号配额恢复后跑通一次完整成功路径
- ⏳ Phase 6+：Runner 打包 exe、Git checkpoint

## 稳定性设计要点

### 一个任务只会被执行一次

同一分钟里，**应用内调度器**和 **Windows 计划任务**会各自触发同一个任务；应用被启动多次也会各跑一套调度器。如果不加约束，两个 agent 进程会同时改同一个项目目录。

三层保障：

1. **应用单实例锁**：第二个实例直接退出，只把已有窗口带到前台。
2. **原子领取**：调度触发时先执行 `UPDATE tasks SET status='preparing' WHERE id=? AND status='scheduled'`，只有改动到 1 行的那一方才真正执行。这条 UPDATE 跨进程原子，因此无论多少触发源（含 MCP 触发的 Runner），只有一个能抢到。
3. **同一任务互斥**：「立即运行」与 MCP 的 `run_task_now` 都会先查该任务是否已有存活进程在跑。

### 应用常驻托盘

**关闭窗口 = 收进托盘，不退出**（有气泡提示）。应用内调度器必须在线才能准点触发。真正退出请右键托盘图标 → **退出（同时停止调度）**。

### 中断运行不会互相误杀

应用主进程、Runner、MCP 服务器是三个进程，各自启动时都会清理「卡在 running 状态」的残留记录。`execution_logs.pid` 记录持有该运行的进程，恢复逻辑只在**进程确实已不存在**时才判为中断——否则 A 进程正在跑的任务会被 B 进程的启动动作改写成「失败」。

### 崩溃不会整体挂掉

主进程注册了 `uncaughtException` / `unhandledRejection` 兜底；子进程的 stdin/stdout/stderr 都挂了 error 监听（子进程瞬间退出时的 EPIPE 以前会直接打崩主进程）。异常追加到 `%APPDATA%\CodexJobScheduler\crash.log`，进程继续运行。

### 环境要求

- **Node ≥ 22.5**：Runner 与 MCP 服务器都依赖内置的 `node:sqlite`。保存任务时会校验计划任务所用的 `node.exe`，版本过低当场提示。
- SQLite 以 WAL + `busy_timeout=15s` 打开，供三个进程并发读写。

## Agent 后端

每个后端是一条配置：**可执行文件 + 参数模板 + 提示词传递方式 + stdout 解析方式**。在 **Agents** 页增删改，不需要动代码。

| 后端 | 说明 |
| --- | --- |
| `codex` | Codex CLI，自动定位 npm 全局安装的原生 exe。参数已实测 |
| `claude` | Claude Code，自动探测 `~/.local/bin/claude.exe` 等位置 |
| `cursor-agent` / `gemini` / `aider` | 预设起点，需自行安装；参数与版本不符时改模板 |
| `custom` | 空白模板：zcode / windsurf / opencode / 自研脚本都能接 |

参数模板占位符：

- `{cwd}` 项目工作目录
- `{model}` 模型名 —— **为空时连同前一个 flag 一起省略**，因此 `-m {model}` 这种写法在未指定模型时不会产生空参数
- `{lastMessageFile}` 最终响应落盘路径（模板里出现它 = 该 CLI 支持把最终消息写文件）
- `{session}` 会话 ID（配在 resume 参数里）

stdout 解析方式（`parser`）：

- `codex-jsonl`：`thread.started` 取会话 ID、`item.agent_message` 取响应
- `claude-jsonl`：`system.init` / `result` 取会话 ID 与最终响应、`is_error` 判失败
- `plain`：不解析，整段输出作为最终响应

最终响应取值优先级：**CLI 落盘文件 > 事件流解析 > 纯文本全文**。

优先级：任务指定 > 项目默认 > 全局默认（codex）。

## MCP 接口

MCP 服务器是独立进程（`dist-mcp/mcp-server.cjs`），**不依赖桌面应用开着**——建任务时会顺手注册 Windows 计划任务，关掉一切也照常执行。

接入方式（以 WorkBuddy 为例，Claude Code / Codex 同理）：

```json
{
  "mcpServers": {
    "job-scheduler": {
      "command": "node",
      "args": ["C:\\...\\codex-job-scheduler\\dist-mcp\\mcp-server.cjs"]
    }
  }
}
```

可用工具（10 个）：

| 工具 | 用途 |
| --- | --- |
| `create_task` | 建任务。`run_at` 支持 `16:00`、`4:00 PM`、`2026-09-24T16:00`、`2026-09-24 16:00` |
| `list_tasks` / `get_task` | 查任务（含最近运行结果） |
| `get_run_result` | 取某次运行的最终响应 |
| `run_task_now` | 立即后台执行（异步返回） |
| `cancel_task` / `delete_task` | 取消（清计划任务、保留任务）/ 彻底删除 |
| `list_projects` / `create_project` | 项目查询与登记 |
| `list_agents` | 可用后端一览 |

约定：**MCP 建的任务默认不关机**（`post_action` 默认 `none`）。界面里默认「关机」是给人用的；让 agent 顺手建个提醒就把机器关掉是灾难，所以两边默认值刻意不同。

## 使用流程（图形界面）

1. 启动应用（`npm run dev` 或 `npm run start`）
2. **项目** → 添加项目 → 选目录（可选：默认提示词、默认 Session ID、默认 Agent 后端）
3. **任务** → 新建任务 → 选项目、填提示词、设执行日期时间、选执行 Agent → 保存
   - 保存时自动注册到 Windows 任务计划程序（`\CodexJobScheduler\Task_<id>`）
   - 勾选「唤醒计算机」后，睡眠状态的电脑到点自动唤醒执行
   - 若提示"拒绝访问"，以管理员身份运行应用后重新保存任务即可
4. 到点：计划程序启动 Runner（或应用内调度器直接执行，二者互斥）→ 调用 agent CLI → 结果写入日志
5. **日志**页查看过程、最终响应、退出码、变更文件

## 可选动作

| 选项 | 行为 |
| --- | --- |
| 限额恢复后自动重试 | 因用量限额中断 → 重排到恢复时间 +2 分钟，最多 10 次 |
| 失败重试次数 | 非限额失败 → 2 分钟后自动重跑，最多 N 次；任务成功后计数归零 |
| 完成后 5 小时刷新 | 项目做完后 5 小时发一条轻量消息开启下一个限额窗口；刷新成功即自动关机收尾 |
| U 盘备份 | 成功后拷贝项目文件到 U 盘并弹出；可指定子目录与 U 盘存放目录（默认 `codex`） |
| 完成后动作 | 无操作 / 关机（有后续安排时自动忽略关机，避免关机后无法继续） |

## 定时与唤醒要点

- 任务保存时自动注册；若服务注册被拒（受限环境），降级为写入任务定义文件（`System32\Tasks\CodexJobScheduler\Task_<id>`，普通用户即可写，重启后由计划服务加载生效）
- 降级文件名与计划任务名同构；删除任务/项目时三种落点（服务注册、降级文件、暂存 XML）都会清掉，不会留下到点乱跑的幽灵任务
- **唤醒依赖「允许使用唤醒定时器」电源设置**：`powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE` 查看，`/setacvalueindex` + `/setdcvalueindex` + `/setactive` 启用（无需管理员）
- S0 现代待机机器上同样适用

## 开发

```bash
npm install
npm run dev          # 开发模式（热重载）
npm run build        # 主进程 / preload / renderer → out/
npm run build:runner # 独立 Runner → dist-runner/
npm run build:mcp    # MCP 服务器 → dist-mcp/
npm run build:all    # 上面三个一起
npm run start        # 运行构建产物
npm run typecheck    # 类型检查
```

改完代码**必须重新构建**：计划任务触发的是 `dist-runner/codex-runner.cjs`，MCP 客户端用的是 `dist-mcp/mcp-server.cjs`，桌面应用加载的是 `out/`。

想在不碰真实数据的前提下自测，把 `APPDATA` 指向临时目录即可（数据目录随之隔离）。

## 数据位置

所有状态存储在 `%APPDATA%\CodexJobScheduler\`：

- `scheduler.db` — SQLite（WAL 模式）
- `logs/<runId>/` — 每次运行的 `stdout.jsonl`、`stderr.log`、`final-response.md`
- `crash.log` — 主进程未捕获异常（存在即说明发生过，值得看一眼）

Electron 主进程、独立 Runner、MCP 服务器解析同一目录，互不依赖。

## 架构

```
src/
├─ shared/          # 三个进程共用（禁止 import electron）
│  ├─ paths.ts      # %APPDATA%\CodexJobScheduler 常量
│  ├─ db.ts         # node:sqlite 数据层 + Schema + 原子领取 + agent 配置
│  ├─ agents.ts     # agent 后端抽象：预设、可执行文件探测、参数模板、输出解析
│  ├─ executor.ts   # 任务执行器（agent 无关）：领取/预检/spawn/落库/后续动作
│  ├─ scheduler.ts  # Windows 任务计划适配器（schtasks + 文件降级）
│  ├─ runat.ts      # 「几点执行」的时间解析与描述
│  ├─ usb.ts        # U 盘备份与弹出
│  └─ types.ts
├─ main/            # Electron 主进程：窗口 + 托盘 + IPC
├─ preload/         # contextBridge（contextIsolation + sandbox 开启）
├─ renderer/        # React UI（含 Agents 管理页）
├─ runner/          # 独立 Runner 入口 cli.ts（--task N [--force]）
└─ mcp/             # MCP 服务器（stdio / NDJSON，10 个工具）
```

## 测试闭环

```bash
npm run build:all
npx esbuild src/runner/seed.ts --bundle --platform=node --format=cjs --outfile=dist-runner/seed.cjs
node dist-runner/seed.cjs <某个项目目录>     # 创建测试 project + task
node dist-runner/codex-runner.cjs --task 1   # 真实调用 agent
node dist-runner/codex-runner.cjs --task 1 --force   # 人工触发（跳过原子领取）
```

MCP 服务器也可以直接手测（一行一个 JSON-RPC）：

```bash
echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | node dist-mcp/mcp-server.cjs
```

## License

[MIT](./LICENSE)
