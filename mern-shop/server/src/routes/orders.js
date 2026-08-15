import { Router } from 'express'
import * as orders from '../controllers/orders.js'

const router = Router()

router.post('/', orders.place)
router.get('/:id', orders.get)

export default router
