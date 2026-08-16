export function createGracefulShutdown({ server, closeStore, setNotReady, drainTimeoutMs = 5000, exit = () => process.exit(0) }) {
  let shuttingDown = false
  return async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    setNotReady()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearInterval(idleSweep)
        resolve()
      }, drainTimeoutMs)
      const idleSweep = setInterval(() => server.closeIdleConnections(), 50)
      server.close(() => {
        clearTimeout(timer)
        clearInterval(idleSweep)
        resolve()
      })
      server.closeIdleConnections()
    })
    await closeStore()
    exit()
  }
}
