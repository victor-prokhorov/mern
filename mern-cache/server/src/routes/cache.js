import { Router } from 'express'
import * as cache from '../controllers/cache.js'

const router = Router()

router.get('/stats', cache.stats)
router.post('/reset', cache.reset)

export default router
