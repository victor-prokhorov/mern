import { Router } from 'express'
import * as actors from '../controllers/actors.js'

const router = Router()

router.get('/', actors.list)
router.post('/', actors.create)

export default router
