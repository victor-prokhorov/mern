async function request(path, options) {
  const res = await fetch(`/api${path}`, options)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || 'request failed')
  return body
}

function send(method, body) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function getCartId() {
  const stored = localStorage.getItem('cartId')
  if (stored) return stored
  const created = crypto.randomUUID()
  localStorage.setItem('cartId', created)
  return created
}

export function loadUser() {
  const stored = localStorage.getItem('user')
  return stored ? JSON.parse(stored) : null
}

export function saveUser(user) {
  localStorage.setItem('user', JSON.stringify(user))
}

export function clearUser() {
  localStorage.removeItem('user')
}

export function listProducts() {
  return request('/products')
}

export function getProduct(id) {
  return request(`/products/${id}`)
}

export function login(email, password) {
  return request('/auth/login', send('POST', { email, password }))
}

export function getCart() {
  return request(`/cart/${getCartId()}`)
}

export function addToCart(productId, qty) {
  return request(`/cart/${getCartId()}/items`, send('POST', { productId, qty }))
}

export function setQty(productId, qty) {
  return request(`/cart/${getCartId()}/items/${productId}`, send('PATCH', { qty }))
}

export function removeFromCart(productId) {
  return request(`/cart/${getCartId()}/items/${productId}`, { method: 'DELETE' })
}

export function placeOrder(userId, customer) {
  return request('/orders', send('POST', { cartId: getCartId(), userId, customer }))
}

export function getOrder(id) {
  return request(`/orders/${id}`)
}
