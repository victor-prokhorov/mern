# Layered Server Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split every server route into router / controller / service / repository layers without changing a single byte of behaviour.

**Architecture:** Routers wire URLs to controllers. Controllers translate HTTP to arguments and results to responses — they never query. Services hold the rules and know nothing about `req`, `res` or status codes; they throw the typed errors from `middleware/error.js`. Repositories own every Mongoose call. Models and middleware are unchanged. The dependency arrow points one way only: router → controller → service → repository → model.

**Tech Stack:** Node (ESM), Express, Mongoose.

**Spec:** `docs/superpowers/specs/2026-08-14-mern-ecommerce-design.md`

## Global Constraints

- Behaviour-preserving. `server/test/**` must not be edited at all, and all 32 tests must pass at the end. That is the acceptance criterion for the whole plan.
- Every error message string stays exactly as it is today.
- Do not install any dependency.
- No comments in any source file.
- No blank lines inside function bodies.
- ESM, `.js` extension on relative imports.
- Branch `refactor/layered-server`, one PR against `main`.
- `server/src/models/*` and `server/src/middleware/error.js` are not modified.

## Target file structure

```
server/src/
  app.js                     unchanged except nothing — routers still mounted the same way
  routes/{products,auth,cart,orders}.js       wiring only, no logic
  controllers/{products,auth,cart,orders}.js  req -> args, result -> res
  services/{products,auth,cart,orders}.js     rules, typed errors, no HTTP
  repositories/{products,users,carts,orders}.js  every Mongoose call
  models/{product,user,cart,order}.js         unchanged
  middleware/error.js                         unchanged
  seed.js                                     rewired through repositories
```

The rule that settles every "which layer does this go in" question: if it mentions `req`, `res` or a status code it is a controller; if it mentions a Mongoose model it is a repository; everything else is a service.

## Interfaces

Repositories:

```
repositories/products.js   findAll(), findById(id), deleteAll(), insertMany(docs)
repositories/users.js      findById(id), findByEmail(email), deleteAll(), create(doc)
repositories/carts.js      loadOrCreate(cartId), findPopulated(cartId), populate(cart), save(cart)
repositories/orders.js     create(doc), findById(id)
```

Services (all throw `BadRequestError` / `NotFoundError` / `UnauthorizedError`):

```
services/products.js  list(), get(id)
services/auth.js      login(email, password)
services/cart.js      view(cartId), addItem(cartId, productId, qty),
                      changeQty(cartId, productId, qty), removeItem(cartId, productId)
services/orders.js    place({ cartId, userId, customer }), get(id)
```

Controllers export one handler per endpoint, each `(req, res)`.

---

### Task 1: Repository layer

**Files:**
- Create: `server/src/repositories/products.js`, `users.js`, `carts.js`, `orders.js`

**Interfaces:**
- Consumes: the four models.
- Produces: the repository functions listed above. Every other layer stops importing models after Task 3.

- [ ] **Step 1: Write the four repositories**

`server/src/repositories/products.js`:

```js
import Product from '../models/product.js'

export function findAll() {
  return Product.find({})
}

export function findById(id) {
  return Product.findById(id)
}

export function deleteAll() {
  return Product.deleteMany({})
}

export function insertMany(docs) {
  return Product.insertMany(docs)
}
```

`server/src/repositories/users.js`:

```js
import User from '../models/user.js'

export function findById(id) {
  return User.findById(id)
}

export function findByEmail(email) {
  return User.findOne({ email })
}

export function deleteAll() {
  return User.deleteMany({})
}

export function create(doc) {
  return User.create(doc)
}
```

`server/src/repositories/carts.js`:

```js
import Cart from '../models/cart.js'

export function loadOrCreate(cartId) {
  return Cart.findOneAndUpdate({ cartId }, { $setOnInsert: { items: [] } }, { upsert: true, returnDocument: 'after' })
}

export function findPopulated(cartId) {
  return Cart.findOne({ cartId }).populate('items.product')
}

export function populate(cart) {
  return cart.populate('items.product')
}

export function save(cart) {
  return cart.save()
}
```

`server/src/repositories/orders.js`:

```js
import Order from '../models/order.js'

export function create(doc) {
  return Order.create(doc)
}

export function findById(id) {
  return Order.findById(id)
}
```

- [ ] **Step 2: Run the suite**

Run: `cd server && npm test`
Expected: 32 passing — nothing consumes the repositories yet, so this only proves the new files parse.

- [ ] **Step 3: Commit**

```bash
git checkout main && git pull --ff-only && git checkout -b refactor/layered-server
git add server/src/repositories
git commit -m "refactor: add repository layer"
```

---

### Task 2: Service layer

**Files:**
- Create: `server/src/services/products.js`, `auth.js`, `cart.js`, `orders.js`

**Interfaces:**
- Consumes: repositories from Task 1, error classes from `middleware/error.js`, `ObjectId` from `mongodb`, `bcrypt`.
- Produces: the service functions listed above. Controllers in Task 3 call only these.

Every rule below is lifted from the current route files verbatim — same order of checks, same messages.

- [ ] **Step 1: Write `server/src/services/products.js`**

```js
import { ObjectId } from 'mongodb'
import * as products from '../repositories/products.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export function list() {
  return products.findAll()
}

export async function get(id) {
  if (!ObjectId.isValid(id)) throw new BadRequestError('invalid product id')
  const product = await products.findById(id)
  if (!product) throw new NotFoundError('product not found')
  return product
}
```

- [ ] **Step 2: Write `server/src/services/auth.js`**

```js
import bcrypt from 'bcrypt'
import * as users from '../repositories/users.js'
import { BadRequestError, UnauthorizedError } from '../middleware/error.js'

export async function login(email, password) {
  if (!email || !password) throw new BadRequestError('email and password are required')
  const user = await users.findByEmail(email)
  const matches = user ? await bcrypt.compare(password, user.passwordHash) : false
  if (!matches) throw new UnauthorizedError('invalid credentials')
  return user
}
```

- [ ] **Step 3: Write `server/src/services/cart.js`**

```js
import { ObjectId } from 'mongodb'
import * as carts from '../repositories/carts.js'
import * as products from '../repositories/products.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

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

async function withoutStaleLines(cart) {
  await carts.populate(cart)
  const before = cart.items.length
  cart.items = cart.items.filter((entry) => entry.product !== null)
  if (cart.items.length !== before) await carts.save(cart)
  return cart
}

export async function view(cartId) {
  const cart = await carts.loadOrCreate(cartId)
  return withoutStaleLines(cart)
}

export async function addItem(cartId, productId, qty) {
  const quantity = parseQty(qty)
  if (!ObjectId.isValid(productId)) throw new BadRequestError('invalid product id')
  const product = await products.findById(productId)
  if (!product) throw new NotFoundError('product not found')
  const cart = await carts.loadOrCreate(cartId)
  const existing = cart.items.find((entry) => entry.product.toString() === productId)
  if (existing) existing.qty += quantity
  else cart.items.push({ product: product._id, qty: quantity })
  await carts.save(cart)
  return withoutStaleLines(cart)
}

export async function changeQty(cartId, productId, qty) {
  const quantity = parseQty(qty)
  const cart = await carts.loadOrCreate(cartId)
  const item = requireItem(cart, productId)
  item.qty = quantity
  await carts.save(cart)
  return withoutStaleLines(cart)
}

export async function removeItem(cartId, productId) {
  const cart = await carts.loadOrCreate(cartId)
  requireItem(cart, productId)
  cart.items = cart.items.filter((entry) => entry.product.toString() !== productId)
  await carts.save(cart)
  return withoutStaleLines(cart)
}
```

- [ ] **Step 4: Write `server/src/services/orders.js`**

```js
import { ObjectId } from 'mongodb'
import * as carts from '../repositories/carts.js'
import * as orders from '../repositories/orders.js'
import * as users from '../repositories/users.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function place({ cartId, userId, customer }) {
  if (!ObjectId.isValid(userId)) throw new BadRequestError('invalid user id')
  const user = await users.findById(userId)
  if (!user) throw new NotFoundError('user not found')
  const cart = await carts.findPopulated(cartId)
  if (!cart || cart.items.length === 0) throw new BadRequestError('cart is empty')
  if (cart.items.some((entry) => entry.product === null)) throw new BadRequestError('cart contains an unavailable product')
  const items = cart.items.map((entry) => ({
    product: entry.product._id,
    name: entry.product.name,
    price: entry.product.price,
    qty: entry.qty
  }))
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const order = await orders.create({ user: user._id, items, total, customer })
  cart.items = []
  await carts.save(cart)
  return order
}

export async function get(id) {
  if (!ObjectId.isValid(id)) throw new BadRequestError('invalid order id')
  const order = await orders.findById(id)
  if (!order) throw new NotFoundError('order not found')
  return order
}
```

- [ ] **Step 5: Run the suite**

Run: `cd server && npm test`
Expected: 32 passing — services exist but nothing calls them yet.

- [ ] **Step 6: Commit**

```bash
git add server/src/services
git commit -m "refactor: add service layer"
```

---

### Task 3: Controllers, routers, and seed rewiring

**Files:**
- Create: `server/src/controllers/products.js`, `auth.js`, `cart.js`, `orders.js`
- Modify: `server/src/routes/products.js`, `auth.js`, `cart.js`, `orders.js` (each becomes wiring only)
- Modify: `server/src/seed.js`

**Interfaces:**
- Consumes: services from Task 2, repositories from Task 1 (seed only).
- Produces: the same HTTP surface as before. `seed.js` keeps exporting `products`, `seedProducts`, `seedUser`, `seedUsers` with identical signatures — the test suite imports all four.

- [ ] **Step 1: Write the controllers**

`server/src/controllers/products.js`:

```js
import * as products from '../services/products.js'

export async function list(req, res) {
  res.json(await products.list())
}

export async function get(req, res) {
  res.json(await products.get(req.params.id))
}
```

`server/src/controllers/auth.js`:

```js
import * as auth from '../services/auth.js'

export async function login(req, res) {
  res.json(await auth.login(req.body.email, req.body.password))
}
```

`server/src/controllers/cart.js`:

```js
import * as cart from '../services/cart.js'

export async function view(req, res) {
  res.json(await cart.view(req.params.cartId))
}

export async function addItem(req, res) {
  res.json(await cart.addItem(req.params.cartId, req.body.productId, req.body.qty))
}

export async function changeQty(req, res) {
  res.json(await cart.changeQty(req.params.cartId, req.params.pid, req.body.qty))
}

export async function removeItem(req, res) {
  res.json(await cart.removeItem(req.params.cartId, req.params.pid))
}
```

`server/src/controllers/orders.js`:

```js
import * as orders from '../services/orders.js'

export async function place(req, res) {
  const order = await orders.place(req.body)
  res.status(201).json(order)
}

export async function get(req, res) {
  res.json(await orders.get(req.params.id))
}
```

- [ ] **Step 2: Reduce the routers to wiring**

`server/src/routes/products.js`:

```js
import { Router } from 'express'
import * as products from '../controllers/products.js'

const router = Router()

router.get('/', products.list)
router.get('/:id', products.get)

export default router
```

`server/src/routes/auth.js`:

```js
import { Router } from 'express'
import * as auth from '../controllers/auth.js'

const router = Router()

router.post('/login', auth.login)

export default router
```

`server/src/routes/cart.js`:

```js
import { Router } from 'express'
import * as cart from '../controllers/cart.js'

const router = Router()

router.get('/:cartId', cart.view)
router.post('/:cartId/items', cart.addItem)
router.patch('/:cartId/items/:pid', cart.changeQty)
router.delete('/:cartId/items/:pid', cart.removeItem)

export default router
```

`server/src/routes/orders.js`:

```js
import { Router } from 'express'
import * as orders from '../controllers/orders.js'

const router = Router()

router.post('/', orders.place)
router.get('/:id', orders.get)

export default router
```

- [ ] **Step 3: Rewire `seed.js` through the repositories**

Replace its model imports with repository imports and its model calls with repository calls. The `products` array, `seedUser`, the `seedProducts`/`seedUsers` signatures and the `NODE_ENV !== 'test'` block all stay exactly as they are:

```js
import * as productsRepo from './repositories/products.js'
import * as usersRepo from './repositories/users.js'
```

```js
export async function seedProducts() {
  await productsRepo.deleteAll()
  return productsRepo.insertMany(products)
}

export async function seedUsers() {
  await usersRepo.deleteAll()
  const passwordHash = await bcrypt.hash(seedUser.password, 10)
  return usersRepo.create({ name: seedUser.name, email: seedUser.email, passwordHash })
}
```

- [ ] **Step 4: Prove no layer skipping**

Run: `cd server && grep -rn "models/" src/ --include=*.js | grep -v "^src/repositories/" | grep -v "^src/models/"`
Expected: no output. Only repositories import models.

Run: `cd server && grep -rln "req\.\|res\." src/services src/repositories`
Expected: no output. No service or repository touches HTTP.

- [ ] **Step 5: Run the full suite**

Run: `cd server && npm test`
Expected: 32 passing, with `server/test/` untouched. Confirm with `git status --short server/test` printing nothing.

- [ ] **Step 6: Commit**

```bash
git add server/src
git commit -m "refactor: split routes into controllers, services and repositories"
```

---

## Notes for the executor

- `export * as name` namespace imports keep call sites reading like `cart.addItem(...)` without a class or a container.
- `withoutStaleLines` is the one piece of shared logic in the cart service; it replaces the old `send(res, cart)` helper, which mixed a response with a mutation — that mixing is exactly what this refactor removes.
- If a test fails at any point, the refactor changed behaviour. Find the difference rather than editing the test.
