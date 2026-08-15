import { Router } from 'express'
import * as notifications from '../controllers/notifications.js'

const router = Router()

router.get('/', notifications.list)
router.post('/:id/read', notifications.markRead)

export default router
