import { Router } from 'express'
import * as auth from '../controllers/auth.js'
import * as passwordReset from '../controllers/passwordReset.js'

const router = Router()

router.post('/login', auth.login)
router.post('/refresh', auth.refresh)
router.post('/logout', auth.logout)
router.post('/forgot-password', passwordReset.forgotPassword)
router.post('/reset-password', passwordReset.reset)

export default router
