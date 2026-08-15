import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

function listJsFiles(dir) {
  const entries = readdirSync(dir)
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...listJsFiles(full))
    else if (full.endsWith('.js')) files.push(full)
  }
  return files
}

function grep(files, pattern) {
  const hits = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  return hits
}

const allFiles = listJsFiles(SRC_DIR)
const serviceAndRepoFiles = allFiles.filter((f) => f.includes(`${path.sep}services${path.sep}`) || f.includes(`${path.sep}repositories${path.sep}`))
const nonRepoFiles = allFiles.filter((f) => !f.includes(`${path.sep}repositories${path.sep}`) && !f.includes(`${path.sep}migrations${path.sep}`))

const reqResHits = grep(serviceAndRepoFiles, /\b(req|res)\b\s*[,)]/)
const sqlHits = grep(nonRepoFiles, /\b(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/i)

console.log('grep 1: req/res in services/ or repositories/')
if (reqResHits.length === 0) console.log('  none found')
else reqResHits.forEach((hit) => console.log(`  ${hit}`))

console.log('grep 2: SQL outside repositories/ (migrations/ is the exempt DDL layer)')
if (sqlHits.length === 0) console.log('  none found')
else sqlHits.forEach((hit) => console.log(`  ${hit}`))

if (reqResHits.length > 0 || sqlHits.length > 0) process.exitCode = 1
