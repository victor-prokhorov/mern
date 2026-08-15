import 'dotenv/config'
import { pool } from '../db.js'
import { migrate, status } from './runner.js'

const command = process.argv[2]

if (command === 'up') {
  const applied = await migrate(pool)
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply')
  await pool.end()
} else if (command === 'status') {
  const rows = await status(pool)
  for (const row of rows) console.log(`${row.applied ? '[x]' : '[ ]'} ${row.version}`)
  await pool.end()
} else {
  console.error('usage: cli.js <up|status>')
  process.exitCode = 1
  await pool.end()
}
