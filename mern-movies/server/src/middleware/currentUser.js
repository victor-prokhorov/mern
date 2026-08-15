export function currentUser(req, res, next) {
  req.userId = req.header('x-user-id')
  next()
}
