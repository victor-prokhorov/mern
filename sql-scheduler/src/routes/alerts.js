import { Router } from 'express'
import * as alertsController from '../controllers/alerts.js'

const router = Router()

router.get('/', alertsController.listAlerts)
router.post('/:id/resolve', alertsController.resolveAlert)

export default router
