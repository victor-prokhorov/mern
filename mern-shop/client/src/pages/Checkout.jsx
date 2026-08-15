import { useState } from 'react'
import { placeOrder } from '../api.js'

export default function Checkout({ user, setPage }) {
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault()
    try {
      const order = await placeOrder({ name, email, address })
      setPage({ name: 'order', id: order._id })
    } catch (err) {
      setError(err.message)
    }
  }
  return (
    <div>
      <h2>Checkout</h2>
      <form onSubmit={submit}>
        <div>
          <label htmlFor="name">Name</label>
          <input id="name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div>
          <label htmlFor="address">Address</label>
          <input id="address" value={address} onChange={(event) => setAddress(event.target.value)} />
        </div>
        <button type="submit">Place order</button>
      </form>
      <button onClick={() => setPage({ name: 'cart' })}>Back to cart</button>
      <p>{error}</p>
    </div>
  )
}
