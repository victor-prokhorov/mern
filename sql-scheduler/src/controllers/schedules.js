import * as schedulesService from '../services/schedules.js'

export async function createSchedule(req, res) {
  const { accountId, name, cadence, timezone, catchupPolicy } = req.body
  const schedule = await schedulesService.createSchedule({
    accountId: Number(accountId),
    name,
    cadence,
    timezone,
    catchupPolicy
  })
  res.status(201).json(schedule)
}

export async function listSchedules(req, res) {
  const schedules = await schedulesService.listSchedules()
  res.status(200).json({ schedules })
}
