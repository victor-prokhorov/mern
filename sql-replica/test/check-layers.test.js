import { expect } from 'chai'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { checkLayers, REQ_RES_PATTERN } from '../scripts/check-layers.js'

describe('check-layers', () => {
  it('catches a service function that calls res.status(...) directly', () => {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), 'sql-replica-layers-'))
    const servicesDir = path.join(srcDir, 'services')
    mkdirSync(servicesDir)
    writeFileSync(path.join(servicesDir, 'violation.js'), 'export function leak(res) {\n  res.status(201)\n}\n')

    const { reqResHits } = checkLayers(srcDir)

    rmSync(srcDir, { recursive: true, force: true })
    expect(reqResHits.some((hit) => hit.includes('res.status(201)'))).to.equal(true)
  })

  it('catches SQL that leaks into a file outside repositories/', () => {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), 'sql-replica-layers-'))
    const replicationDir = path.join(srcDir, 'replication')
    mkdirSync(replicationDir)
    writeFileSync(path.join(replicationDir, 'leak.js'), 'export function q(client) {\n  return client.query("SELECT 1 FROM changes")\n}\n')

    const { sqlHits } = checkLayers(srcDir)

    rmSync(srcDir, { recursive: true, force: true })
    expect(sqlHits.some((hit) => hit.includes('SELECT 1 FROM changes'))).to.equal(true)
  })

  it('the real app has no req/res leakage into services or repositories, and no SQL outside repositories/', () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

    const { reqResHits, sqlHits } = checkLayers(srcDir)

    expect(reqResHits).to.deep.equal([])
    expect(sqlHits).to.deep.equal([])
  })

  it('the shared pattern matches member access, not only a trailing comma or paren', () => {
    expect(REQ_RES_PATTERN.test('res.status(201)')).to.equal(true)
    expect(REQ_RES_PATTERN.test('function leak(req, res) {')).to.equal(true)
    expect(REQ_RES_PATTERN.test('const results = []')).to.equal(false)
  })
})
