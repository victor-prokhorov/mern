import { Router } from 'express'
import * as cart from '../controllers/cart.js'

const router = Router()

router.get('/:cartId', cart.view)
router.post('/:cartId/items', cart.addItem)
router.patch('/:cartId/items/:pid', cart.changeQty)
router.delete('/:cartId/items/:pid', cart.removeItem)

export default router
