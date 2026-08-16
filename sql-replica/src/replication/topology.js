export function createTopology(replicas) {
  return { replicas: replicas.map((r) => ({ name: r.name, lagMs: r.lagMs })), cursor: 0 }
}

export function createEnv({ clock, replicas, stickyMs }) {
  return { clock, topology: createTopology(replicas), stickyMs }
}
