import { Router } from 'express'
import * as messagesController from '../controllers/messages.js'

const router = Router()

router.post('/', messagesController.createMessage)
router.get('/:id', messagesController.getMessage)

export default router
