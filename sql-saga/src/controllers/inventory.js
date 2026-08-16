import * as inventoryService from '../services/inventory.js'

export async function upsertItem(req, res) {
  const item = await inventoryService.upsertItem(req.body)
  res.status(201).json(item)
}

export async function getItem(req, res) {
  const item = await inventoryService.getItem({ sku: req.params.sku })
  res.status(200).json(item)
}
