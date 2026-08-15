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

export async function listTransfers(req, res) {
  const { limit, cursor } = req.query
  const result = await transfersService.listKeyset({ limit, cursor })
  res.status(200).json(result)
}

export async function listTransfersOffsetDemo(req, res) {
  const { limit, offset } = req.query
  const result = await transfersService.listOffsetDemo({ limit, offset })
  res.status(200).json(result)
}
