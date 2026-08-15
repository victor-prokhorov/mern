import { Router } from 'express'
import * as blocks from '../controllers/blocks.js'

const router = Router()

router.post('/', blocks.create)
router.delete('/:id', blocks.remove)

export default router
