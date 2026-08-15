import { useEffect, useState } from 'react'
import { getCart, removeFromCart, setQty } from '../api.js'

export default function Cart({ setPage }) {
  const [cart, setCart] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    getCart().then(setCart).catch((err) => setError(err.message))
  }, [])
  async function change(productId, qty) {
    try {
      setCart(await setQty(productId, qty))
    } catch (err) {
      setError(err.message)
    }
  }
  async function remove(productId) {
    try {
      setCart(await removeFromCart(productId))
    } catch (err) {
      setError(err.message)
    }
  }
  if (!cart) return <p>{error || 'loading'}</p>
  const total = cart.items.reduce((sum, item) => sum + item.product.price * item.qty, 0)
  return (
    <div>
      <h2>Cart</h2>
      {cart.items.length === 0 ? <p>Your cart is empty.</p> : null}
      <table>
        <tbody>
          {cart.items.map((item) => (
            <tr key={item.product._id}>
              <td>{item.product.name}</td>
              <td>{item.product.price} EUR</td>
              <td>
                <input type="number" min="1" value={item.qty} onChange={(event) => change(item.product._id, Number(event.target.value))} />
              </td>
              <td>{item.product.price * item.qty} EUR</td>
              <td>
                <button onClick={() => remove(item.product._id)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Total: {total} EUR</p>
      <button disabled={cart.items.length === 0} onClick={() => setPage({ name: 'checkout' })}>Checkout</button>
      <p>{error}</p>
    </div>
  )
}
