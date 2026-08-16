import * as accountsService from '../services/accounts.js'

export async function createAccount(req, res) {
  const account = await accountsService.createAccount(req.body)
  res.status(201).json(account)
}

export async function getAccount(req, res) {
  const account = await accountsService.getAccount({ accountId: Number(req.params.id) })
  res.status(200).json(account)
}
