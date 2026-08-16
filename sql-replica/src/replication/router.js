import { pool, withTransaction } from '../db.js'
import * as changesRepo from '../repositories/changes.js'
import * as replicaStateRepo from '../repositories/replicaState.js'
import { recordWrite, recordRead } from './session.js'

function withinStickyWindow(session, now, stickyMs) {
  return Boolean(session) && session.lastWriteAt != null && now - session.lastWriteAt < stickyMs
}

function pickReplica(topology, positions, minVersion) {
  const count = topology.replicas.length
  for (let i = 0; i < count; i++) {
    const index = (topology.cursor + i) % count
    const replica = topology.replicas[index]
    if (minVersion == null || positions[replica.name] >= minVersion) {
      topology.cursor = (index + 1) % count
      return replica
    }
  }
  return null
}

function requiredVersion({ token, pinned, session }) {
  let minVersion = 0
  if (token) minVersion = Math.max(minVersion, token)
  if (pinned && session) minVersion = Math.max(minVersion, session.seenVersion)
  return minVersion === 0 ? null : minVersion
}

async function readPositions(client, topology) {
  const positions = {}
  for (const replica of topology.replicas) {
    const state = await replicaStateRepo.get(client, replica.name)
    positions[replica.name] = state ? Number(state.applied_through) : 0
  }
  return positions
}

export async function writeDocument(env, { accountId, docKey, body, session = null }) {
  const writtenAt = new Date(env.clock.now())
  const row = await withTransaction((client) => changesRepo.append(client, { accountId, docKey, body, writtenAt }))
  const version = Number(row.version)
  if (session) recordWrite(session, { version, at: env.clock.now() })
  return { source: 'primary', version, body: row.body, writtenAt: row.written_at }
}

export async function readDocument(env, { accountId, docKey, session = null, consistency = 'eventual', token = null, sticky = false, pinned = false }) {
  const now = env.clock.now()
  const minVersion = requiredVersion({ token, pinned, session })
  const client = await pool.connect()
  try {
    const positions = await readPositions(client, env.topology)
    const primaryLatest = await changesRepo.latestOnPrimary(client, { accountId, docKey })
    const primaryVersion = primaryLatest ? Number(primaryLatest.version) : null
    let source = 'primary'
    let replicaName = null
    let position = null
    let row = primaryLatest
    if (consistency !== 'strong' && !withinStickyWindow(session, now, env.stickyMs)) {
      const replica = pickReplica(env.topology, positions, minVersion)
      if (replica) {
        source = 'replica'
        replicaName = replica.name
        position = positions[replica.name]
        row = await changesRepo.latestAsOf(client, { accountId, docKey, position })
      }
    }
    const version = row ? Number(row.version) : null
    if (session) recordRead(session, version)
    return { source, replica: replicaName, position, version, body: row ? row.body : null, fresh: version === primaryVersion }
  } finally {
    client.release()
  }
}
