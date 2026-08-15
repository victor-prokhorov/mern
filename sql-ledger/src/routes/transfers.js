import { Router } from 'express'
import * as transfersController from '../controllers/transfers.js'

const router = Router()

router.post('/', transfersController.createTransfer)

export default router
