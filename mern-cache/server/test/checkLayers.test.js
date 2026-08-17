import { expect } from 'chai'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { checkLayers, REQ_RES_PATTERN, MODEL_IMPORT_PATTERN } from '../scripts/check-layers.js'

describe('check-layers', () => {
  it('catches a service function that calls res.status(...) directly', () => {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), 'mern-layers-'))
    const servicesDir = path.join(srcDir, 'services')
    mkdirSync(servicesDir)
    writeFileSync(path.join(servicesDir, 'violation.js'), 'export function leak(res) {\n  res.status(201)\n}\n')

    const { reqResHits } = checkLayers(srcDir)

    rmSync(srcDir, { recursive: true, force: true })
    expect(reqResHits.some((hit) => hit.includes('res.status(201)'))).to.equal(true)
  })

  it('catches a model imported outside repositories/', () => {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), 'mern-layers-'))
    const controllersDir = path.join(srcDir, 'controllers')
    mkdirSync(controllersDir)
    writeFileSync(path.join(controllersDir, 'violation.js'), "import { User } from '../models/user.js'\n")

    const { modelHits } = checkLayers(srcDir)

    rmSync(srcDir, { recursive: true, force: true })
    expect(modelHits.some((hit) => hit.includes('../models/user.js'))).to.equal(true)
  })

  it('the real app currently has no req/res leakage into services or repositories, and no model imports outside repositories', () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

    const { reqResHits, modelHits } = checkLayers(srcDir)

    expect(reqResHits).to.deep.equal([])
    expect(modelHits).to.deep.equal([])
  })

  it('the shared patterns match member access and model paths, not lookalikes', () => {
    expect(REQ_RES_PATTERN.test('res.status(201)')).to.equal(true)
    expect(REQ_RES_PATTERN.test('function leak(req, res) {')).to.equal(true)
    expect(REQ_RES_PATTERN.test('const results = []')).to.equal(false)
    expect(MODEL_IMPORT_PATTERN.test("import { User } from '../models/user.js'")).to.equal(true)
    expect(MODEL_IMPORT_PATTERN.test("import { list } from '../repositories/users.js'")).to.equal(false)
  })
})
