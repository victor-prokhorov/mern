import { Router } from 'express'
import * as actors from '../controllers/actors.js'
import * as follows from '../controllers/follows.js'

const router = Router()

router.get('/', actors.list)
router.post('/', actors.create)
router.post('/:id/follow', follows.follow)
router.delete('/:id/follow', follows.unfollow)

export default router
