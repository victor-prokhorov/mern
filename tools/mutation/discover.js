import fs from 'node:fs'
import path from 'node:path'

const ALWAYS_EXCLUDED_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__'])

export function discoverSourceFiles(appRoot, srcSubdir) {
  const root = path.join(appRoot, srcSubdir)
  const results = []
  walk(root, results)
  return results.map((abs) => path.relative(appRoot, abs))
}

function walk(dir, results) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ALWAYS_EXCLUDED_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), results)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    if (entry.name.endsWith('.test.js')) continue
    results.push(path.join(dir, entry.name))
  }
}

export function isMutable(relativePath) {
  if (relativePath.includes('node_modules')) return false
  if (relativePath.endsWith('.test.js')) return false
  if (relativePath.endsWith('.sql')) return false
  if (relativePath.split(path.sep).includes('test')) return false
  if (relativePath.split(path.sep).includes('tests')) return false
  return true
}
