import { Router } from 'express'
import * as schedulesController from '../controllers/schedules.js'

const router = Router()

router.post('/', schedulesController.createSchedule)
router.get('/', schedulesController.listSchedules)

export default router
