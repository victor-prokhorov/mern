import { Router } from 'express'
import * as notificationsController from '../controllers/notifications.js'

const router = Router()

router.get('/', notificationsController.listNotifications)

export default router
