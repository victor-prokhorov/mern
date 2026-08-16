import * as runsService from '../services/runs.js'

export async function listRuns(req, res) {
  const { limit } = req.query
  const runs = await runsService.listRunsWithLag({ limit })
  res.status(200).json({ runs })
}
