import * as auth from '../services/auth.js'

export async function login(req, res) {
  res.json(await auth.login(req.body.email, req.body.password))
}
