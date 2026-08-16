import { Router } from 'express'
import * as documentsController from '../controllers/documents.js'

const router = Router()

router.post('/', documentsController.writeDocument)
router.get('/:accountId/:docKey', documentsController.readDocument)

export default router
