import { useEffect, useState } from 'react'
import { addToCart, getProduct } from '../api.js'

export default function ProductDetail({ id, setPage }) {
  const [product, setProduct] = useState(null)
  const [qty, setQty] = useState(1)
  const [message, setMessage] = useState('')
  useEffect(() => {
    getProduct(id).then(setProduct).catch((err) => setMessage(err.message))
  }, [id])
  async function add() {
    try {
      await addToCart(id, Number(qty))
      setMessage('added to cart')
    } catch (err) {
      setMessage(err.message)
    }
  }
  if (!product) return <p>{message || 'loading'}</p>
  return (
    <div>
      <h2>{product.name}</h2>
      <p>{product.description}</p>
      <p>{product.price} EUR</p>
      <p>in stock: {product.stock}</p>
      <input type="number" min="1" value={qty} onChange={(event) => setQty(event.target.value)} />
      <button onClick={add}>Add to cart</button>
      <button onClick={() => setPage({ name: 'products' })}>Back</button>
      <p>{message}</p>
    </div>
  )
}
