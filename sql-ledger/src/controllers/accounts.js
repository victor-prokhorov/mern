import * as accountsService from '../services/accounts.js'

export async function createAccount(req, res) {
  const account = await accountsService.createAccount(req.body)
  res.status(201).json(account)
}

export async function getBalance(req, res) {
  const accountId = Number(req.params.id)
  const balance = await accountsService.getBalance({ accountId })
  res.status(200).json(balance)
}
