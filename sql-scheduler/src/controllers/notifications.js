import * as notificationsService from '../services/notifications.js'

export async function listNotifications(req, res) {
  const notifications = await notificationsService.listNotifications()
  res.status(200).json({ notifications })
}
