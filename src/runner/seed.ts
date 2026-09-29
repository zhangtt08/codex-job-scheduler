/** One-off seeding helper for local testing. */
import { createProject, createTask } from '../shared/db'
import fs from 'node:fs'

const dir = process.argv[2]
if (!dir || !fs.existsSync(dir)) {
  console.error('Usage: node seed.cjs <project-dir> [task-name] [prompt]')
  process.exit(2)
}
const name = process.argv[3] ?? 'Smoke Test'
const prompt =
  process.argv[4] ?? 'Create a file hello.txt containing exactly: hello from codex runner. Then reply done.'

const p = createProject({ name: 'Hello App', path: dir, default_prompt: null })
console.log(`project ${p.id} created (git: ${p.is_git_repo})`)
const t = createTask({ project_id: p.id, name, prompt, execution_mode: 'new_session' })
console.log(`task ${t.id} created (${t.name}, status=${t.status})`)
