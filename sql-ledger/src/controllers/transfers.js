import * as transfersService from '../services/transfers.js'

export async function createTransfer(req, res) {
  const { reference, fromAccountId, toAccountId, amountMinor } = req.body
  const transfer = await transfersService.createTransfer({
    reference,
    fromAccountId: Number(fromAccountId),
    toAccountId: Number(toAccountId),
    amountMinor: Number(amountMinor)
  })
  res.status(201).json(transfer)
}
