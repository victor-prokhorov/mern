import { Router } from 'express'
import * as auth from '../controllers/auth.js'

const router = Router()

router.post('/login', auth.login)

export default router
