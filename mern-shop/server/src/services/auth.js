import bcrypt from 'bcrypt'
import * as users from '../repositories/users.js'
import { BadRequestError, UnauthorizedError } from '../middleware/error.js'

export async function login(email, password) {
  if (!email || !password) throw new BadRequestError('email and password are required')
  const user = await users.findByEmail(email)
  const matches = user ? await bcrypt.compare(password, user.passwordHash) : false
  if (!matches) throw new UnauthorizedError('invalid credentials')
  return user
}
