import { Router } from 'express'
import * as tickets from '../controllers/tickets.js'
import { identify } from '../middleware/identify.js'

const router = Router()

router.use(identify)
router.post('/', tickets.create)
router.get('/', tickets.list)
router.get('/:id', tickets.get)
router.patch('/:id/status', tickets.updateStatus)
router.patch('/:id/assignee', tickets.updateAssignee)
router.post('/:id/comments', tickets.addComment)

export default router
