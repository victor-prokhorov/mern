import * as passwordReset from '../services/passwordReset.js'

export async function forgotPassword(req, res) {
  res.status(202).json(await passwordReset.forgotPassword(req.body.email))
}

export async function reset(req, res) {
  res.json(await passwordReset.resetPassword(req.body.token, req.body.password))
}
