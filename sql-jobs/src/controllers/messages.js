import * as messagesService from '../services/messages.js'

export async function createMessage(req, res) {
  const message = await messagesService.createMessage(req.body)
  res.status(201).json(message)
}

export async function getMessage(req, res) {
  const message = await messagesService.getMessage({ messageId: Number(req.params.id) })
  res.status(200).json(message)
}
