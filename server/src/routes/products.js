import { Router } from 'express'
import Product from '../models/product.js'

const router = Router()

router.get('/', async (req, res) => {
  const products = await Product.find({})
  res.json(products)
})

export default router
