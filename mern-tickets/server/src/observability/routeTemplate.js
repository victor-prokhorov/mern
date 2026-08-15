const ROUTES = [
  { method: 'POST', pattern: /^\/api\/auth\/login$/, template: '/api/auth/login' },
  { method: 'POST', pattern: /^\/api\/tickets$/, template: '/api/tickets' },
  { method: 'GET', pattern: /^\/api\/tickets$/, template: '/api/tickets' },
  { method: 'GET', pattern: /^\/api\/tickets\/[^/]+$/, template: '/api/tickets/:id' },
  { method: 'PATCH', pattern: /^\/api\/tickets\/[^/]+\/status$/, template: '/api/tickets/:id/status' },
  { method: 'PATCH', pattern: /^\/api\/tickets\/[^/]+\/assignee$/, template: '/api/tickets/:id/assignee' },
  { method: 'POST', pattern: /^\/api\/tickets\/[^/]+\/comments$/, template: '/api/tickets/:id/comments' },
  { method: 'GET', pattern: /^\/healthz$/, template: '/healthz' },
  { method: 'GET', pattern: /^\/readyz$/, template: '/readyz' },
  { method: 'GET', pattern: /^\/metrics$/, template: '/metrics' }
]

export function routeTemplateFor(method, path) {
  const match = ROUTES.find((route) => route.method === method && route.pattern.test(path))
  return match ? match.template : 'unmatched'
}
