import { routeTemplateFor } from './routeTemplate.js'
import { recordRequest } from './metrics.js'

const EXCLUDED_PATHS = new Set(['/metrics', '/healthz', '/readyz'])

export function metricsMiddleware(req, res, next) {
  if (EXCLUDED_PATHS.has(req.path)) return next()
  const method = req.method
  const route = routeTemplateFor(req.method, req.path)
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9
    recordRequest({ method, route, statusCode: res.statusCode, durationSeconds })
  })
  next()
}
