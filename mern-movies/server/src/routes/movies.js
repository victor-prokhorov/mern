import { Router } from 'express'
import * as movies from '../controllers/movies.js'

const router = Router()

router.get('/', movies.list)
router.get('/:id', movies.get)
router.post('/', movies.create)

export default router
