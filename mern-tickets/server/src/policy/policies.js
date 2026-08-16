function ownsTicket(request) {
  return Boolean(request.resource) && request.resource.reporter.toString() === request.subject.id
}

function sameTeam(request) {
  return Boolean(request.resource) && request.resource.teamId === request.subject.teamId
}

function ticketIsClosed(request) {
  return Boolean(request.resource) && request.resource.status === 'closed'
}

export const policies = [
  {
    id: 'reporter-create',
    effect: 'permit',
    actions: ['ticket:create'],
    roles: ['reporter'],
    reason: 'reporters may create tickets',
    condition: () => true
  },
  {
    id: 'reporter-own-ticket',
    effect: 'permit',
    actions: ['ticket:read', 'ticket:comment'],
    roles: ['reporter'],
    reason: 'reporters may read and comment on their own tickets',
    condition: ownsTicket
  },
  {
    id: 'agent-team-access',
    effect: 'permit',
    actions: ['ticket:read', 'ticket:comment', 'ticket:transition', 'ticket:assign'],
    roles: ['agent'],
    reason: 'agents may act on tickets in their own team',
    condition: sameTeam
  },
  {
    id: 'admin-wildcard',
    effect: 'permit',
    actions: ['*'],
    roles: ['admin'],
    reason: 'admins may perform any action',
    condition: () => true
  },
  {
    id: 'admin-no-delete',
    effect: 'deny',
    actions: ['ticket:delete'],
    roles: ['admin'],
    reason: 'even admins may not delete tickets',
    condition: () => true
  },
  {
    id: 'closed-ticket-guard',
    effect: 'deny',
    actions: ['ticket:transition'],
    roles: ['reporter', 'agent'],
    reason: 'a closed ticket may not be transitioned',
    condition: ticketIsClosed
  }
]
