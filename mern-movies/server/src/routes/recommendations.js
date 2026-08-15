import { Router } from 'express'
import * as recommendations from '../controllers/recommendations.js'

const router = Router()

router.get('/', recommendations.list)

export default router
