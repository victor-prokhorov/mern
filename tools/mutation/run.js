import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { buildMutantList, applyMutation } from './mutate.js'
import { shuffleInPlace, seededRng } from './random.js'
import { isMutable } from './discover.js'

let activeRestore = null
let activeChild = null
let stopRequested = false

function restoreActiveMutation() {
  if (!activeRestore) return
  fs.writeFileSync(activeRestore.abs, activeRestore.original)
  activeRestore = null
}

function handleInterrupt() {
  stopRequested = true
  if (activeChild) activeChild.kill('SIGKILL')
}

process.on('SIGINT', handleInterrupt)
process.on('SIGTERM', handleInterrupt)

function assertCleanGitState(appRoot, files) {
  const proc = spawnSync('git', ['status', '--porcelain', '--', ...files], { cwd: appRoot, encoding: 'utf8' })
  if (proc.status !== 0) return
  const dirty = proc.stdout.trim()
  if (dirty.length === 0) return
  throw new Error(
    `refusing to start: target files are not clean in git (a previous interrupted run may have left a mutation applied)\n${dirty}\nrun "git checkout -- <file>" to restore, then retry`
  )
}

function loadPartialResults(outFile) {
  if (!fs.existsSync(outFile)) return new Map()
  const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  const map = new Map()
  for (const entry of raw.results ?? []) map.set(entry.id, entry)
  return map
}

function writeResults(outFile, meta, resultsMap) {
  const results = Array.from(resultsMap.values())
  const payload = { ...meta, generatedAt: new Date().toISOString(), results }
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2))
}

function runTestCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'ignore' })
    activeChild = child
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      activeChild = null
      resolve({ code: null, signal: null, timedOut: false, error: err })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      activeChild = null
      resolve({ code, signal, timedOut, error: null })
    })
  })
}

export async function runMutationTesting(options) {
  const {
    appRoot,
    testCwd,
    testCommand,
    files,
    seed,
    max,
    outFile,
    timeoutMs = 60000,
    onProgress = () => {}
  } = options
  const invalidFiles = files.filter((f) => !isMutable(f))
  if (invalidFiles.length > 0) {
    throw new Error(`refusing to mutate excluded files: ${invalidFiles.join(', ')}`)
  }
  assertCleanGitState(appRoot, files)
  const sources = new Map()
  for (const file of files) {
    const abs = path.join(appRoot, file)
    sources.set(file, fs.readFileSync(abs, 'utf8'))
  }
  const allMutants = buildMutantList(files, sources, seed)
  const order = shuffleInPlace(allMutants.slice(), seededRng(`${seed}:order`))
  const capped = typeof max === 'number' && max > 0 ? order.slice(0, max) : order
  const meta = {
    appRoot,
    files,
    seed,
    max: max ?? null,
    totalCandidates: allMutants.length,
    selected: capped.length
  }
  const resultsMap = loadPartialResults(outFile)
  for (const mutant of capped) {
    if (stopRequested) break
    if (resultsMap.has(mutant.id)) {
      onProgress({ mutant, status: resultsMap.get(mutant.id).status, skipped: true })
      continue
    }
    const abs = path.join(appRoot, mutant.file)
    const original = sources.get(mutant.file)
    const mutatedSource = applyMutation(original, mutant)
    let status = 'error'
    let detail = ''
    fs.writeFileSync(abs, mutatedSource)
    activeRestore = { abs, original }
    try {
      const result = await runTestCommand(testCommand, testCwd, timeoutMs)
      if (stopRequested) {
        status = 'error'
        detail = 'interrupted by signal before the suite finished'
      } else if (result.error) {
        status = 'error'
        detail = String(result.error.message ?? result.error)
      } else if (result.timedOut) {
        status = 'killed'
        detail = 'timed out, treated as a kill: a hung suite is a failed suite'
      } else if (result.signal) {
        status = 'killed'
        detail = `terminated by ${result.signal}`
      } else if (result.code === 0) {
        status = 'survived'
      } else {
        status = 'killed'
      }
    } finally {
      restoreActiveMutation()
    }
    if (stopRequested) break
    const entry = {
      id: mutant.id,
      file: mutant.file,
      line: mutant.line,
      operator: mutant.operator,
      original: mutant.original,
      mutated: mutant.mutated,
      status,
      detail
    }
    resultsMap.set(mutant.id, entry)
    writeResults(outFile, meta, resultsMap)
    onProgress({ mutant, status, skipped: false })
  }
  writeResults(outFile, meta, resultsMap)
  return { meta, results: Array.from(resultsMap.values()) }
}
