export function createSession() {
  return { lastWriteAt: null, lastWriteVersion: 0, seenVersion: 0 }
}

export function recordWrite(session, { version, at }) {
  session.lastWriteVersion = Math.max(session.lastWriteVersion, version)
  session.lastWriteAt = at
}

export function recordRead(session, version) {
  if (version && version > session.seenVersion) session.seenVersion = version
}
