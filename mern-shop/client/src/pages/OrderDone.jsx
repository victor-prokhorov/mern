import { useEffect, useState } from 'react'
import { getOrder } from '../api.js'

export default function OrderDone({ id, setPage }) {
  const [order, setOrder] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    getOrder(id).then(setOrder).catch((err) => setError(err.message))
  }, [id])
  if (!order) return <p>{error || 'loading'}</p>
  return (
    <div>
      <h2>Thank you</h2>
      <p>Order {order._id}</p>
      <p>Status: {order.status}</p>
      <ul>
        {order.items.map((item) => (
          <li key={item.product}>
            {item.name} x {item.qty} — {item.price * item.qty} EUR
          </li>
        ))}
      </ul>
      <p>Total: {order.total} EUR</p>
      <p>Shipping to: {order.customer.address}</p>
      <button onClick={() => setPage({ name: 'products' })}>Keep shopping</button>
    </div>
  )
}
