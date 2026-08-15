import { ObjectId } from 'mongodb'
import * as notificationsRepo from '../repositories/notifications.js'
import { requireUser } from './authorize.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function list(userId) {
  await requireUser(userId)
  return notificationsRepo.findByUser(userId)
}

export async function markRead(userId, notificationId) {
  await requireUser(userId)
  if (!ObjectId.isValid(notificationId)) throw new BadRequestError('invalid notification id')
  const notification = await notificationsRepo.findById(notificationId)
  if (!notification || notification.user.toString() !== userId) throw new NotFoundError('notification not found')
  notification.readAt = new Date()
  return notificationsRepo.save(notification)
}
