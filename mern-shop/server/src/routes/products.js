import { Router } from 'express'
import * as products from '../controllers/products.js'

const router = Router()

router.get('/', products.list)
router.get('/:id', products.get)

export default router
