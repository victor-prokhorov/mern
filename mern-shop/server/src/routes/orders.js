import { Router } from 'express'
import * as orders from '../controllers/orders.js'
import { idempotency } from '../middleware/idempotency.js'

const router = Router()

router.post('/', idempotency({ userIdFrom: (req) => req.body.userId }), orders.place)
router.get('/:id', orders.get)

export default router
