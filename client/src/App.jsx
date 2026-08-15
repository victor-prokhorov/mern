import { useState } from 'react'
import { clearUser, loadUser } from './api.js'
import Products from './pages/Products.jsx'
import ProductDetail from './pages/ProductDetail.jsx'

export default function App() {
  const [page, setPage] = useState({ name: 'products' })
  const [user, setUser] = useState(loadUser())
  function signOut() {
    clearUser()
    setUser(null)
    setPage({ name: 'products' })
  }
  return (
    <div>
      <h1>Shop</h1>
      <nav>
        <button onClick={() => setPage({ name: 'products' })}>Products</button>
        {user ? <button onClick={signOut}>Log out ({user.email})</button> : null}
      </nav>
      <hr />
      {page.name === 'products' ? <Products setPage={setPage} /> : null}
      {page.name === 'product' ? <ProductDetail id={page.id} setPage={setPage} /> : null}
    </div>
  )
}
