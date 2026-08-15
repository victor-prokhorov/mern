import * as auth from '../services/auth.js'

export async function login(req, res) {
  res.json(await auth.login(req.body.email, req.body.password))
}

export async function refresh(req, res) {
  res.json(await auth.refresh(req.body.refreshToken))
}

export async function logout(req, res) {
  res.json(await auth.logout(req.body.refreshToken))
}
