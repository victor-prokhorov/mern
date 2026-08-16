import { Router } from 'express'
import * as accountsController from '../controllers/accounts.js'

const router = Router()

router.post('/', accountsController.createAccount)
router.get('/', accountsController.listAccounts)

export default router
