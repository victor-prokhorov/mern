import * as accountsService from '../services/accounts.js'

export async function createAccount(req, res) {
  const { name, timezone } = req.body
  const account = await accountsService.createAccount({ name, timezone })
  res.status(201).json(account)
}

export async function listAccounts(req, res) {
  const accounts = await accountsService.listAccounts()
  res.status(200).json({ accounts })
}
