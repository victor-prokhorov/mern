import * as documentsService from '../services/documents.js'

export async function writeDocument(req, res) {
  const { accountId, docKey, body, sessionId } = req.body
  const result = await documentsService.writeDocument({ accountId: Number(accountId), docKey, body, sessionId })
  res.status(201).json(result)
}

export async function readDocument(req, res) {
  const { accountId, docKey } = req.params
  const { sessionId, consistency, token, sticky, pinned } = req.query
  const result = await documentsService.readDocument({
    accountId: Number(accountId),
    docKey,
    sessionId,
    consistency,
    token: token ? Number(token) : null,
    sticky: sticky === '1' || sticky === 'true',
    pinned: pinned === '1' || pinned === 'true'
  })
  res.status(200).json(result)
}
