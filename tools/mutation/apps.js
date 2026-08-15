import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const reposRoot = path.resolve(here, '..', '..')

export const APPS = {
  'mern-shop': {
    appRoot: path.join(reposRoot, 'mern-shop', 'server'),
    testCommand: 'npm test'
  },
  'mern-tickets': {
    appRoot: path.join(reposRoot, 'mern-tickets', 'server'),
    testCommand: 'npm test'
  },
  'mern-movies': {
    appRoot: path.join(reposRoot, 'mern-movies', 'server'),
    testCommand: 'npm test'
  },
  'sql-ledger': {
    appRoot: path.join(reposRoot, 'sql-ledger'),
    testCommand: 'npm test'
  }
}
