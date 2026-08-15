import { expect } from 'chai'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { checkLayers, REQ_RES_PATTERN } from '../scripts/check-layers.js'

describe('check-layers', () => {
  it('catches a service function that calls res.status(...) directly', () => {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), 'sql-ledger-layers-'))
    const servicesDir = path.join(srcDir, 'services')
    mkdirSync(servicesDir)
    writeFileSync(path.join(servicesDir, 'violation.js'), 'export function leak(res) {\n  res.status(201)\n}\n')

    const { reqResHits } = checkLayers(srcDir)

    rmSync(srcDir, { recursive: true, force: true })
    expect(reqResHits.some((hit) => hit.includes('res.status(201)'))).to.equal(true)
  })

  it('the real app currently has no req/res leakage into services or repositories', () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

    const { reqResHits } = checkLayers(srcDir)

    expect(reqResHits).to.deep.equal([])
  })

  it('the shared pattern matches member access, not only a trailing comma or paren', () => {
    expect(REQ_RES_PATTERN.test('res.status(201)')).to.equal(true)
    expect(REQ_RES_PATTERN.test('function leak(req, res) {')).to.equal(true)
    expect(REQ_RES_PATTERN.test('const results = []')).to.equal(false)
  })
})
