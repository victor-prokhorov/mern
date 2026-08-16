import * as alertsService from '../services/alerts.js'

export async function listAlerts(req, res) {
  const alerts = await alertsService.listAlerts()
  res.status(200).json({ alerts })
}

export async function resolveAlert(req, res) {
  const alert = await alertsService.resolveAlert(Number(req.params.id))
  res.status(200).json(alert)
}
