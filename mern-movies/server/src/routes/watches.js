import { Router } from 'express'
import * as watches from '../controllers/watches.js'

const router = Router()

router.post('/', watches.create)

export default router
