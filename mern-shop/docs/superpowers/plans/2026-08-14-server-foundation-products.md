# Server Foundation + Products Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Express + Mongoose server with a Product model, product read endpoints, a seed script, and a working mocha test harness.

**Architecture:** ESM everywhere. `app.js` builds the Express app and is import-safe (no `listen`), so tests drive it over real HTTP with `chai-http` while `index.js` owns connecting and listening. Routes never `try/catch`; `express-async-errors` funnels rejections into one error middleware that maps error classes to status codes. Tests run against a real local MongoDB in a separate `mern-shop-test` database, dropped before each test.

**Tech Stack:** Node (ESM), Express, Mongoose, mocha, chai, chai-http, cross-env.

**Spec:** `docs/superpowers/specs/2026-08-14-mern-ecommerce-design.md`

## Global Constraints

- Server dependencies are limited to exactly: `bcrypt`, `cors`, `dotenv`, `express`, `express-async-errors`, `mongodb`, `mongoose`, `chai`, `chai-http`, `mocha`, `mocha-junit-reporter`, `mocha-multi-reporters`, `cross-env`. Adding anything else, including `nodemon` or `supertest`, is out of bounds.
- No comments in any source or test file.
- No blank lines inside function bodies, except test bodies which use setup / blank / run / blank / assert.
- All server code is ESM (`"type": "module"`), `.js` extension required on relative imports.
- Tests require a local `mongod` running on `127.0.0.1:27017`.
- Branch for this plan: `feat/server-products`. PR against `main`. Victor merges, squashing to one commit. No Notion ticket.
- Commits follow red then green: the failing-test commit lands before the commit that makes it pass.

---

### Task 1: Server scaffold and GET /api/products

**Files:**
- Create: `server/package.json`
- Create: `server/.gitignore`
- Create: `server/.env.example`
- Create: `server/.mocharc.json`
- Create: `server/src/db.js`
- Create: `server/src/app.js`
- Create: `server/src/index.js`
- Create: `server/src/models/product.js`
- Create: `server/src/routes/products.js`
- Create: `server/test/helpers.js`
- Test: `server/test/products.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `connect(uri: string): Promise<Mongoose>` from `src/db.js`
  - `app` (default export, an Express app) from `src/app.js`
  - `Product` (default export, Mongoose model) from `src/models/product.js`
  - `useTestDb(): void` from `test/helpers.js`, registers `before` / `beforeEach` / `after` hooks inside a `describe`

- [ ] **Step 1: Create the package and install dependencies**

```bash
mkdir -p server/src/models server/src/routes server/src/middleware server/test
cd server
npm init -y
npm pkg set type=module
npm install bcrypt cors dotenv express express-async-errors mongodb mongoose
npm install --save-dev chai chai-http mocha mocha-junit-reporter mocha-multi-reporters cross-env
npm pkg set scripts.dev="node --watch src/index.js"
npm pkg set scripts.start="node src/index.js"
npm pkg set scripts.seed="node src/seed.js"
npm pkg set scripts.test="cross-env NODE_ENV=test MONGO_URI=mongodb://127.0.0.1:27017/mern-shop-test mocha"
```

- [ ] **Step 2: Create the support files**

`server/.gitignore`:

```
node_modules
.env
test-results
```

`server/.env.example`:

```
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/mern-shop
```

`server/.mocharc.json`:

```json
{
  "spec": "test/**/*.test.js",
  "timeout": 10000,
  "exit": true
}
```

- [ ] **Step 3: Write the failing test**

`server/test/helpers.js`:

```js
import mongoose from 'mongoose'
import { connect } from '../src/db.js'

export function useTestDb() {
  before(async () => {
    await connect(process.env.MONGO_URI)
  })
  beforeEach(async () => {
    await mongoose.connection.dropDatabase()
  })
  after(async () => {
    await mongoose.disconnect()
  })
}
```

`server/test/products.test.js`:

```js
import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import app from '../src/app.js'
import Product from '../src/models/product.js'
import { useTestDb } from './helpers.js'

const chai = use(chaiHttp)

describe('GET /api/products', () => {
  useTestDb()

  it('returns an empty array when there are no products', async () => {
    const res = await chai.request.execute(app).get('/api/products')

    expect(res).to.have.status(200)
    expect(res.body).to.deep.equal([])
  })

  it('returns every stored product', async () => {
    await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await Product.create({ name: 'Poster', price: 20, stock: 5 })

    const res = await chai.request.execute(app).get('/api/products')

    expect(res).to.have.status(200)
    expect(res.body).to.have.length(2)
    expect(res.body.map((p) => p.name).sort()).to.deep.equal(['Mug', 'Poster'])
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '.../src/app.js'`

- [ ] **Step 5: Commit the failing test**

```bash
git checkout -b feat/server-products
git add server/package.json server/package-lock.json server/.gitignore server/.env.example server/.mocharc.json server/test
git commit -m "test: failing product listing test"
```

Paste the real failure output from Step 4 into the commit body.

- [ ] **Step 6: Write the implementation**

`server/src/db.js`:

```js
import mongoose from 'mongoose'

export function connect(uri) {
  return mongoose.connect(uri)
}
```

`server/src/models/product.js`:

```js
import mongoose from 'mongoose'

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number, required: true, min: 0 },
  image: { type: String, default: '' },
  stock: { type: Number, default: 0, min: 0 }
})

export default mongoose.model('Product', productSchema)
```

`server/src/routes/products.js`:

```js
import { Router } from 'express'
import Product from '../models/product.js'

const router = Router()

router.get('/', async (req, res) => {
  const products = await Product.find({})
  res.json(products)
})

export default router
```

`server/src/app.js`:

```js
import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import products from './routes/products.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use('/api/products', products)

export default app
```

`server/src/index.js`:

```js
import 'dotenv/config'
import app from './app.js'
import { connect } from './db.js'

const port = process.env.PORT || 5000
const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-shop'

await connect(uri)
app.listen(port, () => console.log(`listening on ${port}`))
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS, 2 passing

- [ ] **Step 8: Commit**

```bash
git add server/src
git commit -m "feat: express app with product listing endpoint"
```

---

### Task 2: GET /api/products/:id with the error middleware

**Files:**
- Create: `server/src/middleware/error.js`
- Modify: `server/src/routes/products.js`
- Modify: `server/src/app.js`
- Test: `server/test/products.test.js`

**Interfaces:**
- Consumes: `Product` from `src/models/product.js`, `app` from `src/app.js`, `useTestDb` from `test/helpers.js`.
- Produces:
  - `class NotFoundError extends Error` with `status = 404`, from `src/middleware/error.js`
  - `class BadRequestError extends Error` with `status = 400`, from `src/middleware/error.js`
  - `errorHandler(err, req, res, next)` from `src/middleware/error.js`, mounted last in `app.js`. Later tasks throw these two classes instead of writing status codes in routes.

- [ ] **Step 1: Write the failing test**

Append to `server/test/products.test.js`:

```js
describe('GET /api/products/:id', () => {
  useTestDb()

  it('returns the product', async () => {
    const created = await Product.create({ name: 'Mug', price: 12, stock: 3 })

    const res = await chai.request.execute(app).get(`/api/products/${created._id}`)

    expect(res).to.have.status(200)
    expect(res.body.name).to.equal('Mug')
    expect(res.body.price).to.equal(12)
  })

  it('returns 404 for an unknown but well formed id', async () => {
    const unknownId = '64b7f0f0f0f0f0f0f0f0f0f0'

    const res = await chai.request.execute(app).get(`/api/products/${unknownId}`)

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('product not found')
  })

  it('returns 400 for a malformed id', async () => {
    const res = await chai.request.execute(app).get('/api/products/not-an-id')

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('invalid product id')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — the three new tests get 404 from Express's default handler with an HTML body, so `res.body.error` is `undefined`

- [ ] **Step 3: Commit the failing test**

```bash
git add server/test/products.test.js
git commit -m "test: failing product detail tests"
```

Paste the real failure output from Step 2 into the commit body.

- [ ] **Step 4: Write the implementation**

`server/src/middleware/error.js`:

```js
export class NotFoundError extends Error {
  constructor(message) {
    super(message)
    this.status = 404
  }
}

export class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

export function errorHandler(err, req, res, next) {
  if (err.name === 'ValidationError' || err.name === 'CastError') {
    return res.status(400).json({ error: err.message })
  }
  res.status(err.status || 500).json({ error: err.message })
}
```

Add to `server/src/routes/products.js`, above `export default router`:

```js
import { ObjectId } from 'mongodb'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

router.get('/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) throw new BadRequestError('invalid product id')
  const product = await Product.findById(req.params.id)
  if (!product) throw new NotFoundError('product not found')
  res.json(product)
})
```

Keep the two `import` lines at the top of the file with the existing imports.

In `server/src/app.js`, import the handler and mount it after the routes:

```js
import { errorHandler } from './middleware/error.js'
```

```js
app.use('/api/products', products)
app.use(errorHandler)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS, 5 passing

- [ ] **Step 6: Commit**

```bash
git add server/src
git commit -m "feat: product detail endpoint with central error handler"
```

---

### Task 3: Seed script

**Files:**
- Create: `server/src/seed.js`
- Test: `server/test/seed.test.js`

**Interfaces:**
- Consumes: `Product` from `src/models/product.js`, `connect` from `src/db.js`.
- Produces:
  - `products: Array<{name, description, price, image, stock}>` from `src/seed.js`
  - `seedProducts(): Promise<Product[]>` from `src/seed.js`, wipes the products collection then inserts `products`. Task 2 of the auth PR extends this file with a seeded user.

- [ ] **Step 1: Write the failing test**

`server/test/seed.test.js`:

```js
import { expect } from 'chai'
import Product from '../src/models/product.js'
import { products, seedProducts } from '../src/seed.js'
import { useTestDb } from './helpers.js'

describe('seedProducts', () => {
  useTestDb()

  it('inserts every seed product', async () => {
    await seedProducts()

    const stored = await Product.find({})

    expect(stored).to.have.length(products.length)
    expect(products).to.have.length(8)
  })

  it('is idempotent', async () => {
    await seedProducts()

    await seedProducts()

    const stored = await Product.find({})
    expect(stored).to.have.length(products.length)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '.../src/seed.js'`

- [ ] **Step 3: Commit the failing test**

```bash
git add server/test/seed.test.js
git commit -m "test: failing seed script tests"
```

Paste the real failure output from Step 2 into the commit body.

- [ ] **Step 4: Write the implementation**

`server/src/seed.js`:

```js
import 'dotenv/config'
import mongoose from 'mongoose'
import { connect } from './db.js'
import Product from './models/product.js'

export const products = [
  { name: 'Ceramic Mug', description: 'Holds coffee.', price: 12, image: 'https://placehold.co/200', stock: 25 },
  { name: 'Canvas Tote', description: 'Carries things.', price: 18, image: 'https://placehold.co/200', stock: 40 },
  { name: 'Notebook', description: 'Dotted, A5.', price: 9, image: 'https://placehold.co/200', stock: 60 },
  { name: 'Enamel Pin', description: 'Small and shiny.', price: 5, image: 'https://placehold.co/200', stock: 100 },
  { name: 'Poster', description: 'Printed on matte paper.', price: 20, image: 'https://placehold.co/200', stock: 15 },
  { name: 'Sticker Pack', description: 'Ten vinyl stickers.', price: 7, image: 'https://placehold.co/200', stock: 80 },
  { name: 'T-Shirt', description: 'Heavy cotton.', price: 28, image: 'https://placehold.co/200', stock: 30 },
  { name: 'Cap', description: 'One size.', price: 22, image: 'https://placehold.co/200', stock: 20 }
]

export async function seedProducts() {
  await Product.deleteMany({})
  return Product.insertMany(products)
}

if (process.env.NODE_ENV !== 'test') {
  await connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-shop')
  await seedProducts()
  await mongoose.disconnect()
  console.log(`seeded ${products.length} products`)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS, 7 passing

- [ ] **Step 6: Run the seeder against the dev database**

Run: `cd server && cp .env.example .env && npm run seed`
Expected: `seeded 8 products`

- [ ] **Step 7: Commit**

```bash
git add server/src/seed.js
git commit -m "feat: product seed script"
```

---

### Task 4: CI reporters and README

**Files:**
- Create: `server/.mocharc-reporters.json`
- Modify: `server/package.json`
- Create: `README.md` (replaces the current one-line file)

**Interfaces:**
- Consumes: the `test` script from Task 1.
- Produces: `npm run test:ci`, writing `test-results/results.xml` in JUnit format while still printing the spec reporter.

- [ ] **Step 1: Add the reporter config**

`server/.mocharc-reporters.json`:

```json
{
  "reporterEnabled": "spec, mocha-junit-reporter",
  "mochaJunitReporterReporterOptions": {
    "mochaFile": "test-results/results.xml"
  }
}
```

- [ ] **Step 2: Add the script**

```bash
cd server
npm pkg set scripts.test:ci="cross-env NODE_ENV=test MONGO_URI=mongodb://127.0.0.1:27017/mern-shop-test mocha --reporter mocha-multi-reporters --reporter-options configFile=.mocharc-reporters.json"
```

- [ ] **Step 3: Verify both reporters run**

Run: `cd server && npm run test:ci && ls test-results/results.xml`
Expected: the spec output prints, 7 passing, and `test-results/results.xml` exists

- [ ] **Step 4: Write the README**

`README.md`:

```markdown
# mern

Minimal MERN ecommerce, built to practice the stack. No CSS, no styling — raw
HTML from React.

## Requirements

- Node 20+
- A local MongoDB on `mongodb://127.0.0.1:27017`

## Server

```bash
cd server
npm install
cp .env.example .env
npm run seed
npm run dev
```

API on `http://localhost:5000`.

## Tests

```bash
cd server
npm test
npm run test:ci
```

`npm test` drops and rebuilds the `mern-shop-test` database on every test, so a
local `mongod` must be running. `test:ci` additionally writes JUnit XML to
`server/test-results/results.xml`.

## Docs

- Design spec: `docs/superpowers/specs/2026-08-14-mern-ecommerce-design.md`
- Plans: `docs/superpowers/plans/`
```

- [ ] **Step 5: Commit**

```bash
git add server/.mocharc-reporters.json server/package.json README.md
git commit -m "chore: junit reporter and readme"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/server-products
gh pr create --base main --head feat/server-products --title "feat: server foundation and product endpoints"
```

Body covers: what the PR adds, the endpoints, how to run the tests, and that a
local mongod is required. No Notion ticket, no deploy command — this repo has
neither.

---

## Notes for the executor

- `chai` 5 and `chai-http` 5 are ESM-only and `chai-http` 5 replaced `chai.request(app)` with `chai.request.execute(app)`. If the installed `chai-http` turns out to be 4.x, `chai.request(app)` is the correct call and `use()` is `chai.use()`; adjust the tests rather than downgrading or adding a dependency.
- If `bcrypt` fails to build on install, it is still required by the next PR; report the build error rather than swapping it for `bcryptjs`, which is not authorized.
