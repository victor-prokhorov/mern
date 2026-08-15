# Auth, Cart and Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the server: login against a bcrypt-seeded user, a server-side anonymous cart, and order placement that reprices from the database and empties the cart.

**Architecture:** Continues the server built by `2026-08-14-server-foundation-products.md`. Every route throws typed errors handled by `src/middleware/error.js`; nothing writes status codes inline except the happy path. Carts are keyed by a client-minted `cartId` string and hold references to products; orders snapshot name and price at purchase time so later product edits cannot rewrite history.

**Tech Stack:** Node (ESM), Express, Mongoose, bcrypt, mocha, chai, chai-http.

**Spec:** `docs/superpowers/specs/2026-08-14-mern-ecommerce-design.md`

## Global Constraints

- Server dependencies are limited to exactly: `bcrypt`, `cors`, `dotenv`, `express`, `express-async-errors`, `mongodb`, `mongoose`, `chai`, `chai-http`, `mocha`, `mocha-junit-reporter`, `mocha-multi-reporters`, `cross-env`. Nothing else may be installed.
- No comments in any source or test file.
- No blank lines inside function bodies, except test bodies which use setup / blank / run / blank / assert.
- ESM everywhere, `.js` extension on relative imports.
- Tests need MongoDB on `127.0.0.1:27017`; they drop `mern-shop-test` before each test.
- Each task is its own branch and its own PR against `main`, squash-merged: Task 1 on `feat/auth-login`, Task 2 on `feat/cart`, Task 3 on `feat/orders`. Branch each one from an up-to-date `main`.
- Commits follow red then green, with the real failing output in the red commit body.

---

### Task 1: Login with a bcrypt-seeded user

**Branch:** `feat/auth-login`

**Files:**
- Create: `server/src/models/user.js`
- Create: `server/src/routes/auth.js`
- Modify: `server/src/middleware/error.js`
- Modify: `server/src/app.js`
- Modify: `server/src/seed.js`
- Test: `server/test/auth.test.js`
- Test: `server/test/seed.test.js`

**Interfaces:**
- Consumes: `errorHandler`, `BadRequestError`, `NotFoundError` from `src/middleware/error.js`; `seedProducts`, `products` from `src/seed.js`; `useTestDb` from `test/helpers.js`.
- Produces:
  - `User` (default export, Mongoose model) from `src/models/user.js`, with a `toJSON` transform that strips `passwordHash` and `__v`
  - `class UnauthorizedError extends Error` with `status = 401`, from `src/middleware/error.js`
  - `seedUser: { name, email, password }` and `seedUsers(): Promise<User>` from `src/seed.js`
  - `POST /api/auth/login`

- [ ] **Step 1: Write the failing tests**

`server/test/auth.test.js`:

```js
import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import app from '../src/app.js'
import { seedUser, seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

const chai = use(chaiHttp)

describe('POST /api/auth/login', () => {
  useTestDb()

  it('returns the user without the password hash', async () => {
    await seedUsers()

    const res = await chai.request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: seedUser.password })

    expect(res).to.have.status(200)
    expect(res.body.email).to.equal(seedUser.email)
    expect(res.body.name).to.equal(seedUser.name)
    expect(res.body._id).to.be.a('string')
    expect(res.body).to.not.have.property('passwordHash')
  })

  it('rejects a wrong password', async () => {
    await seedUsers()

    const res = await chai.request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: 'wrong' })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
  })

  it('rejects an unknown email', async () => {
    await seedUsers()

    const res = await chai.request.execute(app).post('/api/auth/login').send({ email: 'nobody@shop.test', password: seedUser.password })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
  })

  it('rejects a request missing credentials', async () => {
    await seedUsers()

    const res = await chai.request.execute(app).post('/api/auth/login').send({ email: seedUser.email })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('email and password are required')
  })
})
```

Append to `server/test/seed.test.js`, importing `User` from `../src/models/user.js` and `seedUsers` from `../src/seed.js` alongside the existing imports:

```js
describe('seedUsers', () => {
  useTestDb()

  it('creates one user whose password is hashed', async () => {
    await seedUsers()

    const stored = await User.find({})

    expect(stored).to.have.length(1)
    expect(stored[0].email).to.equal(seedUser.email)
    expect(stored[0].passwordHash).to.not.equal(seedUser.password)
    expect(stored[0].passwordHash).to.have.length.greaterThan(20)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — `The requested module '../src/seed.js' does not provide an export named 'seedUsers'`

- [ ] **Step 3: Commit the failing tests**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/auth-login
git add server/test
git commit -m "test: failing login and user seeding tests"
```

Paste the real failure output from Step 2 into the commit body.

- [ ] **Step 4: Write the implementation**

`server/src/models/user.js`:

```js
import mongoose from 'mongoose'

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true }
})

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash
    delete ret.__v
    return ret
  }
})

export default mongoose.model('User', userSchema)
```

Add to `server/src/middleware/error.js`:

```js
export class UnauthorizedError extends Error {
  constructor(message) {
    super(message)
    this.status = 401
  }
}
```

`server/src/routes/auth.js`:

```js
import { Router } from 'express'
import bcrypt from 'bcrypt'
import User from '../models/user.js'
import { BadRequestError, UnauthorizedError } from '../middleware/error.js'

const router = Router()

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) throw new BadRequestError('email and password are required')
  const user = await User.findOne({ email })
  const matches = user ? await bcrypt.compare(password, user.passwordHash) : false
  if (!matches) throw new UnauthorizedError('invalid credentials')
  res.json(user)
})

export default router
```

In `server/src/app.js`, import the router and mount it before `errorHandler`:

```js
import auth from './routes/auth.js'
```

```js
app.use('/api/auth', auth)
```

In `server/src/seed.js`, add the imports `bcrypt` and `User`, then add above the `NODE_ENV` block:

```js
export const seedUser = { name: 'Demo User', email: 'demo@shop.test', password: 'demo1234' }

export async function seedUsers() {
  await User.deleteMany({})
  const passwordHash = await bcrypt.hash(seedUser.password, 10)
  return User.create({ name: seedUser.name, email: seedUser.email, passwordHash })
}
```

and extend the `NODE_ENV` block so it seeds users too, before disconnecting:

```js
if (process.env.NODE_ENV !== 'test') {
  await connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-shop')
  await seedProducts()
  await seedUsers()
  await mongoose.disconnect()
  console.log(`seeded ${products.length} products and 1 user: ${seedUser.email} / ${seedUser.password}`)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS, 12 passing

- [ ] **Step 6: Commit, push, open and merge the PR**

```bash
git add server/src
git commit -m "feat: login endpoint backed by a bcrypt-seeded user"
git push -u origin feat/auth-login
gh pr create --base main --head feat/auth-login --title "feat: login endpoint" --body "..."
gh pr merge --squash --delete-branch
```

The PR body states what it adds, the endpoint, the seeded credentials, and that login returns no token by design (recorded in the spec).

---

### Task 2: Server-side cart

**Branch:** `feat/cart`

**Files:**
- Create: `server/src/models/cart.js`
- Create: `server/src/routes/cart.js`
- Modify: `server/src/app.js`
- Test: `server/test/cart.test.js`

**Interfaces:**
- Consumes: `Product` from `src/models/product.js`; `BadRequestError`, `NotFoundError` from `src/middleware/error.js`; `useTestDb` from `test/helpers.js`.
- Produces:
  - `Cart` (default export, Mongoose model) from `src/models/cart.js`, shape `{ cartId: String, items: [{ product: ObjectId ref Product, qty: Number }] }`
  - `GET /api/cart/:cartId`, `POST /api/cart/:cartId/items`, `PATCH /api/cart/:cartId/items/:pid`, `DELETE /api/cart/:cartId/items/:pid`, each responding with the populated cart. Task 3 reads carts through the `Cart` model directly.

- [ ] **Step 1: Write the failing tests**

`server/test/cart.test.js`:

```js
import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import app from '../src/app.js'
import Product from '../src/models/product.js'
import { useTestDb } from './helpers.js'

const chai = use(chaiHttp)

describe('cart', () => {
  useTestDb()

  it('returns an empty cart for an unknown cart id', async () => {
    const res = await chai.request.execute(app).get('/api/cart/cart-1')

    expect(res).to.have.status(200)
    expect(res.body.cartId).to.equal('cart-1')
    expect(res.body.items).to.deep.equal([])
  })

  it('adds an item and returns it populated', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })

    const res = await chai.request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    expect(res).to.have.status(200)
    expect(res.body.items).to.have.length(1)
    expect(res.body.items[0].qty).to.equal(2)
    expect(res.body.items[0].product.name).to.equal('Mug')
  })

  it('merges quantity when the same product is added twice', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await chai.request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    const res = await chai.request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 3 })

    expect(res.body.items).to.have.length(1)
    expect(res.body.items[0].qty).to.equal(5)
  })

  it('rejects adding an unknown product', async () => {
    const res = await chai.request.execute(app).post('/api/cart/cart-1/items').send({ productId: '64b7f0f0f0f0f0f0f0f0f0f0', qty: 1 })

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('product not found')
  })

  it('rejects a quantity below one', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })

    const res = await chai.request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 0 })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('qty must be a positive integer')
  })

  it('updates the quantity of an item', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await chai.request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    const res = await chai.request.execute(app).patch(`/api/cart/cart-1/items/${product._id}`).send({ qty: 7 })

    expect(res).to.have.status(200)
    expect(res.body.items[0].qty).to.equal(7)
  })

  it('returns 404 when updating an item that is not in the cart', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })

    const res = await chai.request.execute(app).patch(`/api/cart/cart-1/items/${product._id}`).send({ qty: 7 })

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('item not in cart')
  })

  it('removes an item', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await chai.request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    const res = await chai.request.execute(app).delete(`/api/cart/cart-1/items/${product._id}`)

    expect(res).to.have.status(200)
    expect(res.body.items).to.deep.equal([])
  })

  it('keeps carts separate', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await chai.request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    const res = await chai.request.execute(app).get('/api/cart/cart-2')

    expect(res.body.items).to.deep.equal([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — the cart requests return Express's default 404 HTML, so `res.body.cartId` is `undefined`

- [ ] **Step 3: Commit the failing tests**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/cart
git add server/test/cart.test.js
git commit -m "test: failing cart endpoint tests"
```

Paste the real failure output from Step 2 into the commit body.

- [ ] **Step 4: Write the implementation**

`server/src/models/cart.js`:

```js
import mongoose from 'mongoose'

const cartSchema = new mongoose.Schema({
  cartId: { type: String, required: true, unique: true, index: true },
  items: [
    {
      _id: false,
      product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
      qty: { type: Number, required: true, min: 1 }
    }
  ]
})

export default mongoose.model('Cart', cartSchema)
```

`server/src/routes/cart.js`:

```js
import { Router } from 'express'
import { ObjectId } from 'mongodb'
import Cart from '../models/cart.js'
import Product from '../models/product.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

const router = Router()

async function loadCart(cartId) {
  const existing = await Cart.findOne({ cartId })
  if (existing) return existing
  return Cart.create({ cartId, items: [] })
}

function parseQty(value) {
  if (!Number.isInteger(value) || value < 1) throw new BadRequestError('qty must be a positive integer')
  return value
}

function requireItem(cart, productId) {
  if (!ObjectId.isValid(productId)) throw new BadRequestError('invalid product id')
  const item = cart.items.find((entry) => entry.product.toString() === productId)
  if (!item) throw new NotFoundError('item not in cart')
  return item
}

async function send(res, cart) {
  await cart.populate('items.product')
  res.json(cart)
}

router.get('/:cartId', async (req, res) => {
  const cart = await loadCart(req.params.cartId)
  await send(res, cart)
})

router.post('/:cartId/items', async (req, res) => {
  const qty = parseQty(req.body.qty)
  if (!ObjectId.isValid(req.body.productId)) throw new BadRequestError('invalid product id')
  const product = await Product.findById(req.body.productId)
  if (!product) throw new NotFoundError('product not found')
  const cart = await loadCart(req.params.cartId)
  const existing = cart.items.find((entry) => entry.product.toString() === req.body.productId)
  if (existing) existing.qty += qty
  else cart.items.push({ product: product._id, qty })
  await cart.save()
  await send(res, cart)
})

router.patch('/:cartId/items/:pid', async (req, res) => {
  const qty = parseQty(req.body.qty)
  const cart = await loadCart(req.params.cartId)
  const item = requireItem(cart, req.params.pid)
  item.qty = qty
  await cart.save()
  await send(res, cart)
})

router.delete('/:cartId/items/:pid', async (req, res) => {
  const cart = await loadCart(req.params.cartId)
  requireItem(cart, req.params.pid)
  cart.items = cart.items.filter((entry) => entry.product.toString() !== req.params.pid)
  await cart.save()
  await send(res, cart)
})

export default router
```

In `server/src/app.js`, import the router and mount it before `errorHandler`:

```js
import cart from './routes/cart.js'
```

```js
app.use('/api/cart', cart)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS, 21 passing

- [ ] **Step 6: Commit, push, open and merge the PR**

```bash
git add server/src
git commit -m "feat: server-side cart endpoints"
git push -u origin feat/cart
gh pr create --base main --head feat/cart --title "feat: server-side cart" --body "..."
gh pr merge --squash --delete-branch
```

---

### Task 3: Orders

**Branch:** `feat/orders`

**Files:**
- Create: `server/src/models/order.js`
- Create: `server/src/routes/orders.js`
- Modify: `server/src/app.js`
- Test: `server/test/orders.test.js`

**Interfaces:**
- Consumes: `Cart` from `src/models/cart.js`, `Product` from `src/models/product.js`, `User` from `src/models/user.js`, the error classes, `seedUsers`/`seedUser` from `src/seed.js`.
- Produces:
  - `Order` (default export, Mongoose model) from `src/models/order.js`
  - `POST /api/orders` returning 201 with the created order, `GET /api/orders/:id`. These are the last server endpoints; the client PRs consume all of them.

- [ ] **Step 1: Write the failing tests**

`server/test/orders.test.js`:

```js
import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import app from '../src/app.js'
import Cart from '../src/models/cart.js'
import Product from '../src/models/product.js'
import { seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

const chai = use(chaiHttp)

const customer = { name: 'Ada', email: 'ada@shop.test', address: '1 Main Street' }

async function setUpCart() {
  const user = await seedUsers()
  const mug = await Product.create({ name: 'Mug', price: 12, stock: 3 })
  const poster = await Product.create({ name: 'Poster', price: 20, stock: 5 })
  await Cart.create({ cartId: 'cart-1', items: [{ product: mug._id, qty: 2 }, { product: poster._id, qty: 1 }] })
  return { user, mug, poster }
}

describe('orders', () => {
  useTestDb()

  it('creates an order priced from the database', async () => {
    const { user } = await setUpCart()

    const res = await chai.request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer })

    expect(res).to.have.status(201)
    expect(res.body.total).to.equal(44)
    expect(res.body.items).to.have.length(2)
    expect(res.body.items[0].name).to.equal('Mug')
    expect(res.body.items[0].price).to.equal(12)
    expect(res.body.status).to.equal('pending')
  })

  it('ignores prices sent by the client', async () => {
    const { user } = await setUpCart()

    const res = await chai.request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer, total: 1 })

    expect(res.body.total).to.equal(44)
  })

  it('empties the cart', async () => {
    const { user } = await setUpCart()

    await chai.request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer })

    const cart = await Cart.findOne({ cartId: 'cart-1' })
    expect(cart.items).to.have.length(0)
  })

  it('rejects an empty cart', async () => {
    const { user } = await setUpCart()
    await Cart.updateOne({ cartId: 'cart-1' }, { items: [] })

    const res = await chai.request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('cart is empty')
  })

  it('rejects an unknown user', async () => {
    await setUpCart()

    const res = await chai.request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: '64b7f0f0f0f0f0f0f0f0f0f0', customer })

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('user not found')
  })

  it('rejects a missing customer address', async () => {
    const { user } = await setUpCart()

    const res = await chai.request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer: { name: 'Ada', email: 'ada@shop.test' } })

    expect(res).to.have.status(400)
  })

  it('returns a stored order', async () => {
    const { user } = await setUpCart()
    const created = await chai.request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer })

    const res = await chai.request.execute(app).get(`/api/orders/${created.body._id}`)

    expect(res).to.have.status(200)
    expect(res.body.total).to.equal(44)
  })

  it('returns 404 for an unknown order', async () => {
    const res = await chai.request.execute(app).get('/api/orders/64b7f0f0f0f0f0f0f0f0f0f0')

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('order not found')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '.../src/models/order.js'`

- [ ] **Step 3: Commit the failing tests**

```bash
git checkout main && git pull --ff-only && git checkout -b feat/orders
git add server/test/orders.test.js
git commit -m "test: failing order endpoint tests"
```

Paste the real failure output from Step 2 into the commit body.

- [ ] **Step 4: Write the implementation**

`server/src/models/order.js`:

```js
import mongoose from 'mongoose'

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
      {
        _id: false,
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        qty: { type: Number, required: true, min: 1 }
      }
    ],
    total: { type: Number, required: true, min: 0 },
    customer: {
      name: { type: String, required: true },
      email: { type: String, required: true },
      address: { type: String, required: true }
    },
    status: { type: String, default: 'pending' }
  },
  { timestamps: true }
)

export default mongoose.model('Order', orderSchema)
```

`server/src/routes/orders.js`:

```js
import { Router } from 'express'
import { ObjectId } from 'mongodb'
import Cart from '../models/cart.js'
import Order from '../models/order.js'
import User from '../models/user.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

const router = Router()

router.post('/', async (req, res) => {
  const { cartId, userId, customer } = req.body
  if (!ObjectId.isValid(userId)) throw new BadRequestError('invalid user id')
  const user = await User.findById(userId)
  if (!user) throw new NotFoundError('user not found')
  const cart = await Cart.findOne({ cartId }).populate('items.product')
  if (!cart || cart.items.length === 0) throw new BadRequestError('cart is empty')
  const items = cart.items.map((entry) => ({
    product: entry.product._id,
    name: entry.product.name,
    price: entry.product.price,
    qty: entry.qty
  }))
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const order = await Order.create({ user: user._id, items, total, customer })
  cart.items = []
  await cart.save()
  res.status(201).json(order)
})

router.get('/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) throw new BadRequestError('invalid order id')
  const order = await Order.findById(req.params.id)
  if (!order) throw new NotFoundError('order not found')
  res.json(order)
})

export default router
```

In `server/src/app.js`, import the router and mount it before `errorHandler`:

```js
import orders from './routes/orders.js'
```

```js
app.use('/api/orders', orders)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS, 29 passing

- [ ] **Step 6: Commit, push, open and merge the PR**

```bash
git add server/src
git commit -m "feat: order placement and lookup"
git push -u origin feat/orders
gh pr create --base main --head feat/orders --title "feat: orders" --body "..."
gh pr merge --squash --delete-branch
```

---

## Notes for the executor

- `parseQty` throwing from a helper is intentional: `express-async-errors` carries the throw to the error middleware exactly as it would from the route body.
- `_id: false` on subdocument arrays keeps cart and order items free of ids nobody uses.
- If a test's expected count of passing tests differs from the plan because an earlier PR added tests, trust the suite, not the number.
