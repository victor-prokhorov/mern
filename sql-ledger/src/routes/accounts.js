import { Router } from 'express'
import * as accountsController from '../controllers/accounts.js'

const router = Router()

router.post('/', accountsController.createAccount)
router.get('/:id/balance', accountsController.getBalance)

export default router
