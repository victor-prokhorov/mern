import { Router } from 'express'
import * as runsController from '../controllers/runs.js'

const router = Router()

router.get('/', runsController.listRuns)

export default router
