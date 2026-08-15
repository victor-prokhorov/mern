import { resolveRequestId } from './requestId.js'
import { routeTemplateFor } from './routeTemplate.js'
import { runWithContext } from './context.js'

export function requestContext(req, res, next) {
  const requestId = resolveRequestId(req.headers['x-request-id'])
  res.set('X-Request-Id', requestId)
  const route = routeTemplateFor(req.method, req.path)
  runWithContext({ requestId, userId: null, route }, next)
}
