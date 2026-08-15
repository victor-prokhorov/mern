async function request(path, options) {
  const res = await fetch(`/api${path}`, options)
  if (res.status === 401) {
    clearSession()
    window.dispatchEvent(new CustomEvent('shop:session-expired'))
    throw new Error('session expired, please log in again')
  }
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || 'request failed')
  return body
}

function authHeader() {
  const accessToken = loadAccessToken()
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
}

function send(method, body, { auth = false } = {}) {
  return { method, headers: { 'Content-Type': 'application/json', ...(auth ? authHeader() : {}) }, body: JSON.stringify(body) }
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

export function loadAccessToken() {
  return localStorage.getItem('accessToken')
}

export function saveSession({ user, accessToken, refreshToken }) {
  localStorage.setItem('user', JSON.stringify(user))
  localStorage.setItem('accessToken', accessToken)
  localStorage.setItem('refreshToken', refreshToken)
}

export function clearSession() {
  localStorage.removeItem('user')
  localStorage.removeItem('accessToken')
  localStorage.removeItem('refreshToken')
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

export function placeOrder(customer) {
  return request('/orders', send('POST', { cartId: getCartId(), customer }, { auth: true }))
}

export function getOrder(id) {
  return request(`/orders/${id}`)
}
