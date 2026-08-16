import { Router } from 'express'
import * as inventoryController from '../controllers/inventory.js'

const router = Router()

router.post('/', inventoryController.upsertItem)
router.get('/:sku', inventoryController.getItem)

export default router
