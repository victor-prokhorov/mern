export function createGracefulShutdown({ server, closeStore, setNotReady, drainTimeoutMs = 5000, exit = () => process.exit(0) }) {
  let shuttingDown = false
  return async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    setNotReady()
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, drainTimeoutMs)
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    await closeStore()
    exit()
  }
}
