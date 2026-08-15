import { useState } from 'react'
import { login, saveSession } from '../api.js'

export default function Login({ setPage, onSignedIn, notice }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault()
    try {
      const session = await login(email, password)
      saveSession(session)
      onSignedIn(session.user)
      setPage({ name: 'products' })
    } catch (err) {
      setError(err.message)
    }
  }
  return (
    <div>
      <h2>Log in</h2>
      {notice ? <p>{notice}</p> : null}
      <p>Seeded account: demo@shop.test / demo1234</p>
      <form onSubmit={submit}>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <button type="submit">Log in</button>
      </form>
      <p>{error}</p>
    </div>
  )
}
