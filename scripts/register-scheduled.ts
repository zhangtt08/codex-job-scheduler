import { getDb, getTask } from '../src/shared/db'
import { syncScheduledTask } from '../src/shared/scheduler'

async function main() {
  getDb()
  const task = getTask(Number(process.argv[2]))
  if (!task) return console.error('task not found')
  const res = await syncScheduledTask(task)
  console.log('schedule result:', JSON.stringify(res))
}
main()
