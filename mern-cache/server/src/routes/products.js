import { Router } from 'express'
import * as products from '../controllers/products.js'

const router = Router()

router.get('/', products.list)
router.post('/', products.create)
router.get('/:id', products.get)
router.patch('/:id', products.update)

export default router
