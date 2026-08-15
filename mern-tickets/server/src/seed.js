import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcrypt'
import { connect } from './db.js'
import * as usersRepo from './repositories/users.js'
import * as ticketsRepo from './repositories/tickets.js'
import * as ticketEventsRepo from './repositories/ticketEvents.js'

export const password = 'demo1234'

export const seedPeople = [
  { name: 'Ada Admin', email: 'ada@tickets.test', role: 'admin', teamId: 'team-a' },
  { name: 'Gale Agent', email: 'gale@tickets.test', role: 'agent', teamId: 'team-a' },
  { name: 'Remy Agent', email: 'remy@tickets.test', role: 'agent', teamId: 'team-b' },
  { name: 'Rae Reporter', email: 'rae@tickets.test', role: 'reporter', teamId: 'team-a' },
  { name: 'Sam Reporter', email: 'sam@tickets.test', role: 'reporter', teamId: 'team-a' },
  { name: 'Lee Reporter', email: 'lee@tickets.test', role: 'reporter', teamId: 'team-b' }
]

export async function seedUsers() {
  await usersRepo.deleteAll()
  const passwordHash = await bcrypt.hash(password, 10)
  const created = []
  for (const person of seedPeople) {
    created.push(await usersRepo.create({ ...person, passwordHash }))
  }
  return created
}

const SLA_HOURS = { urgent: 4, high: 24, normal: 72, low: 168 }

function dueAtFor(priority) {
  return new Date(Date.now() + SLA_HOURS[priority] * 60 * 60 * 1000)
}

export async function seedTickets(people) {
  await ticketsRepo.deleteAll()
  await ticketEventsRepo.deleteAll()
  const [admin, gale, remy, rae, sam, lee] = people
  const specs = [
    { title: 'Cannot log in', body: 'Password reset link is broken.', priority: 'urgent', status: 'open', reporter: rae, assignee: null },
    { title: 'Export is slow', body: 'CSV export takes minutes.', priority: 'normal', status: 'triaged', assignee: gale, reporter: sam },
    { title: 'Typo on invoice', body: 'Company name misspelled.', priority: 'low', status: 'in_progress', assignee: gale, reporter: rae },
    { title: 'Billing double-charged', body: 'Charged twice this month.', priority: 'high', status: 'resolved', assignee: remy, reporter: lee },
    { title: 'Old bug, already fixed', body: 'Confirmed fixed in latest release.', priority: 'normal', status: 'closed', assignee: remy, reporter: lee }
  ]
  const created = []
  for (const spec of specs) {
    const ticket = await ticketsRepo.create({
      title: spec.title,
      body: spec.body,
      priority: spec.priority,
      status: spec.status,
      reporter: spec.reporter._id,
      assignee: spec.assignee ? spec.assignee._id : null,
      teamId: spec.reporter.teamId,
      dueAt: dueAtFor(spec.priority)
    })
    await ticketEventsRepo.create({ ticket: ticket._id, actor: spec.reporter._id, type: 'created', from: null, to: 'open' })
    if (spec.status !== 'open') {
      await ticketEventsRepo.create({ ticket: ticket._id, actor: admin._id, type: 'status_changed', from: 'open', to: spec.status })
    }
    created.push(ticket)
  }
  return created
}

if (process.env.NODE_ENV !== 'test') {
  await connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-tickets')
  const people = await seedUsers()
  await seedTickets(people)
  await mongoose.disconnect()
  console.log(`seeded ${people.length} users and 5 tickets. password for all: ${password}`)
}
