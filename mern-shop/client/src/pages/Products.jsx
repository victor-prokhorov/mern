import { useEffect, useState } from 'react'
import { listProducts } from '../api.js'

export default function Products({ setPage }) {
  const [products, setProducts] = useState([])
  const [error, setError] = useState('')
  useEffect(() => {
    listProducts().then(setProducts).catch((err) => setError(err.message))
  }, [])
  if (error) return <p>{error}</p>
  return (
    <div>
      <h2>Products</h2>
      <ul>
        {products.map((product) => (
          <li key={product._id}>
            <button onClick={() => setPage({ name: 'product', id: product._id })}>{product.name}</button>
            <span> {product.price} EUR</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
