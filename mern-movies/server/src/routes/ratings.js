import { Router } from 'express'
import * as ratings from '../controllers/ratings.js'

const router = Router()

router.post('/', ratings.upsert)

export default router
