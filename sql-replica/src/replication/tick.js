import { withTransaction } from '../db.js'
import * as changesRepo from '../repositories/changes.js'
import * as replicaStateRepo from '../repositories/replicaState.js'

export async function tick(env) {
  const now = env.clock.now()
  const results = []
  for (const replica of env.topology.replicas) {
    const cutoff = new Date(now - replica.lagMs)
    const result = await withTransaction(async (client) => {
      const position = await changesRepo.maxVersionUpTo(client, cutoff)
      await replicaStateRepo.advance(client, replica.name, { appliedThrough: position, appliedAt: new Date(now) })
      return { replica: replica.name, appliedThrough: position }
    })
    results.push(result)
  }
  return results
}
