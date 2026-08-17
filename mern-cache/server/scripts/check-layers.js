import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQ_RES_PATTERN = /\b(req|res)\b\s*(?:[[.,)]|;|$)/
export const MODEL_IMPORT_PATTERN = /from\s+['"][^'"]*\/models\//

export function listJsFiles(dir) {
  const entries = readdirSync(dir)
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...listJsFiles(full))
    else if (full.endsWith('.js')) files.push(full)
  }
  return files
}

export function grep(files, pattern) {
  const hits = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  return hits
}

export function checkLayers(srcDir) {
  const allFiles = listJsFiles(srcDir)
  const serviceAndRepoFiles = allFiles.filter((f) => f.includes(`${path.sep}services${path.sep}`) || f.includes(`${path.sep}repositories${path.sep}`))
  const nonRepoFiles = allFiles.filter((f) => !f.includes(`${path.sep}repositories${path.sep}`) && !f.includes(`${path.sep}models${path.sep}`))
  const reqResHits = grep(serviceAndRepoFiles, REQ_RES_PATTERN)
  const modelHits = grep(nonRepoFiles, MODEL_IMPORT_PATTERN)
  return { reqResHits, modelHits }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const { reqResHits, modelHits } = checkLayers(srcDir)

  console.log('grep 1: req/res in services/ or repositories/')
  if (reqResHits.length === 0) console.log('  none found')
  else reqResHits.forEach((hit) => console.log(`  ${hit}`))

  console.log('grep 2: model imports outside repositories/ (models/ is the schema layer)')
  if (modelHits.length === 0) console.log('  none found')
  else modelHits.forEach((hit) => console.log(`  ${hit}`))

  if (reqResHits.length > 0 || modelHits.length > 0) process.exitCode = 1
}
