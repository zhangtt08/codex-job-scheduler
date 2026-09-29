import { getDb, recoverInterruptedRuns } from '../src/shared/db'
getDb()
console.log('recovered:', recoverInterruptedRuns())
