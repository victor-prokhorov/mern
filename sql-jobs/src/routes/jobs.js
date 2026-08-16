import { Router } from 'express'
import * as jobsController from '../controllers/jobs.js'

const router = Router()

router.get('/', jobsController.listJobs)
router.post('/:id/retry', jobsController.retryDeadJob)

export default router
