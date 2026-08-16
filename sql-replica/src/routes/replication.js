import { Router } from 'express'
import * as replicationController from '../controllers/replication.js'

const router = Router()

router.post('/tick', replicationController.tick)
router.get('/state', replicationController.state)

export default router
