import { Router } from 'express'
import bcrypt from 'bcrypt'
import User from '../models/user.js'
import { BadRequestError, UnauthorizedError } from '../middleware/error.js'

const router = Router()

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) throw new BadRequestError('email and password are required')
  const user = await User.findOne({ email })
  const matches = user ? await bcrypt.compare(password, user.passwordHash) : false
  if (!matches) throw new UnauthorizedError('invalid credentials')
  res.json(user)
})

export default router
