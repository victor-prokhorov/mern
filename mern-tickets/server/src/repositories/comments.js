import Comment from '../models/comment.js'

export function create(doc) {
  return Comment.create(doc)
}

export function findByTicket(ticketId) {
  return Comment.find({ ticket: ticketId }).sort({ createdAt: 1 })
}

export function findRecentByAuthor(authorId, since) {
  return Comment.find({ author: authorId, createdAt: { $gte: since } }).sort({ createdAt: -1 })
}

export function deleteAll() {
  return Comment.deleteMany({})
}
