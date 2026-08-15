import { Router } from 'express'
import * as orders from '../controllers/orders.js'
import { idempotency } from '../middleware/idempotency.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.post('/', requireAuth, idempotency({ userIdFrom: (req) => req.userId }), orders.place)
router.get('/:id', orders.get)

export default router
