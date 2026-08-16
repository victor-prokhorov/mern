import { Router } from 'express'
import * as ordersController from '../controllers/orders.js'

const router = Router()

router.post('/', ordersController.placeOrder)

export default router
