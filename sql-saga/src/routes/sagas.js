import { Router } from 'express'
import * as ordersController from '../controllers/orders.js'

const router = Router()

router.get('/:id', ordersController.getSaga)

export default router
