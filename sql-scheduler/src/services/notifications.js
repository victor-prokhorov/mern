import { pool } from '../db.js'
import * as notificationsRepo from '../repositories/notifications.js'

export async function listNotifications() {
  return notificationsRepo.list(pool)
}
