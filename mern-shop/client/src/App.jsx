import { useEffect, useState } from 'react'
import { clearSession, loadUser } from './api.js'
import Products from './pages/Products.jsx'
import ProductDetail from './pages/ProductDetail.jsx'
import Cart from './pages/Cart.jsx'
import Login from './pages/Login.jsx'
import Checkout from './pages/Checkout.jsx'
import OrderDone from './pages/OrderDone.jsx'

export default function App() {
  const [page, setPage] = useState({ name: 'products' })
  const [user, setUser] = useState(loadUser())
  function signOut() {
    clearSession()
    setUser(null)
    setPage({ name: 'products' })
  }
  useEffect(() => {
    function onSessionExpired() {
      setUser(null)
      setPage({ name: 'login', notice: 'your session expired, please log in again' })
    }
    window.addEventListener('shop:session-expired', onSessionExpired)
    return () => window.removeEventListener('shop:session-expired', onSessionExpired)
  }, [])
  return (
    <div>
      <h1>Shop</h1>
      <nav>
        <button onClick={() => setPage({ name: 'products' })}>Products</button>
        <button onClick={() => setPage({ name: 'cart' })}>Cart</button>
        {user ? <button onClick={signOut}>Log out ({user.email})</button> : <button onClick={() => setPage({ name: 'login' })}>Log in</button>}
      </nav>
      <hr />
      {page.name === 'products' ? <Products setPage={setPage} /> : null}
      {page.name === 'product' ? <ProductDetail id={page.id} setPage={setPage} /> : null}
      {page.name === 'login' ? <Login setPage={setPage} onSignedIn={setUser} notice={page.notice} /> : null}
      {page.name === 'cart' ? <Cart setPage={setPage} /> : null}
      {page.name === 'checkout' && user ? <Checkout user={user} setPage={setPage} /> : null}
      {page.name === 'checkout' && !user ? <Login setPage={setPage} onSignedIn={setUser} notice="Log in to place your order." /> : null}
      {page.name === 'order' ? <OrderDone id={page.id} setPage={setPage} /> : null}
    </div>
  )
}
