import { Router } from 'express'
import * as transfersController from '../controllers/transfers.js'

const router = Router()

router.post('/', transfersController.createTransfer)
router.get('/offset-demo', transfersController.listTransfersOffsetDemo)
router.get('/', transfersController.listTransfers)

export default router
