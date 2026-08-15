import { Router } from 'express'
import { ObjectId } from 'mongodb'
import Product from '../models/product.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

const router = Router()

router.get('/', async (req, res) => {
  const products = await Product.find({})
  res.json(products)
})

router.get('/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) throw new BadRequestError('invalid product id')
  const product = await Product.findById(req.params.id)
  if (!product) throw new NotFoundError('product not found')
  res.json(product)
})

export default router
