# Minimal MERN Ecommerce — Design

Date: 2026-08-14

## Goal

Smallest complete ecommerce loop on the MERN stack: browse products, build a
server-side cart, log in, place an order. Learning project. No styling, no CSS,
no UI library — raw HTML tags rendered by React.

## Constraints

- Authorized server dependencies, and only these: `bcrypt`, `cors`, `dotenv`,
  `express`, `express-async-errors`, `mongodb`, `mongoose`, `chai`, `chai-http`,
  `mocha`, `mocha-junit-reporter`, `mocha-multi-reporters`, `cross-env`.
- Client dependencies: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`.
  No router, no state library, no CSS.
- No comments in source files.
- One branch per unit of work, PR against `main`, merged only by the repo owner,
  squashed to a single commit.

## Dependency roles

| Dependency | Role |
|---|---|
| `express` | HTTP server, routing, middleware |
| `mongoose` | Schemas, models, validation, `populate` for cart items |
| `mongodb` | Mongoose's driver. Direct use limited to `ObjectId.isValid` guards so malformed ids return 400 rather than 500 |
| `dotenv` | Loads `MONGO_URI` and `PORT` from `.env` |
| `cors` | Client runs on a different origin (`:5173`) than the API (`:5000`) |
| `bcrypt` | Hashes the seeded user's password; `compare` on login |
| `express-async-errors` | Routes throw instead of `try/catch`; rejections reach the central error middleware |
| `mocha` | Test runner |
| `chai` | Assertions |
| `chai-http` | Drives real HTTP requests against the Express app in tests |
| `mocha-multi-reporters` | Runs `spec` and JUnit reporters together |
| `mocha-junit-reporter` | JUnit XML output for CI |
| `cross-env` | Portable env vars in npm scripts |

## Layout

```
server/
  .env.example
  .mocharc-reporters.json
  src/
    app.js            express app, middleware, routes, error handler
    index.js          connect + listen
    db.js             mongoose connect helper
    models/product.js
    models/user.js
    models/cart.js
    models/order.js
    routes/products.js
    routes/auth.js
    routes/cart.js
    routes/orders.js
    seed.js
  test/
    products.test.js
    auth.test.js
    cart.test.js
    orders.test.js
client/
  index.html
  vite.config.js
  src/
    main.jsx
    App.jsx
    api.js
    pages/Products.jsx
    pages/ProductDetail.jsx
    pages/Login.jsx
    pages/Cart.jsx
    pages/Checkout.jsx
    pages/OrderDone.jsx
```

`app.js` is separate from `index.js` so tests import the app without opening a
listening socket.

## Data model

```
Product { name, description, price: Number, image: String, stock: Number }
User    { name, email (unique), passwordHash }
Cart    { cartId: String (unique, indexed), items: [{ product: ObjectId ref Product, qty: Number }] }
Order   { user: ObjectId ref User,
          items: [{ product: ObjectId, name: String, price: Number, qty: Number }],
          total: Number,
          customer: { name, email, address },
          status: String default 'pending' }
```

`cartId` is a UUID minted by the client and kept in `localStorage`. Carts are
anonymous and are not tied to a user.

Order items are a snapshot of name and price at purchase time, so later product
edits do not rewrite order history. The total and every line price are computed
server-side from the database; the client never sends money values.

## API

```
GET    /api/products
GET    /api/products/:id
POST   /api/auth/login                 { email, password } -> { _id, name, email } | 401
GET    /api/cart/:cartId               upserts an empty cart, returns populated items
POST   /api/cart/:cartId/items         { productId, qty }
PATCH  /api/cart/:cartId/items/:pid    { qty }
DELETE /api/cart/:cartId/items/:pid
POST   /api/orders                     { cartId, userId, customer } -> creates order, empties cart
GET    /api/orders/:id
```

Error handling: routes throw; `express-async-errors` routes rejections to a
single error middleware that maps Mongoose `ValidationError` to 400, `CastError`
to 400, an explicit `NotFoundError` to 404, and anything else to 500.

## Authentication

Login only. There is no register route and no register UI. `seed.js` creates one
user with `bcrypt.hash(password, 10)`; the login page renders those credentials
as plain text above the form so the app is usable straight after seeding.

No session mechanism is authorized (`jsonwebtoken` and `express-session` are not
on the dependency list). Login returns the user document minus the hash; the
client stores it in `localStorage` and sends `userId` in the order payload. The
server therefore trusts a client-supplied `userId`. This is knowingly insecure
and acceptable only because this is a learning MVP; a token would be the first
thing to add before any real deployment.

Checkout is login-gated on the client: an unauthenticated user reaching checkout
is shown the login page instead.

## Client

No router. `App.jsx` holds `const [page, setPage] = useState({ name: 'products' })`
and switch-renders one page component, passing `setPage` down. Navigation is
`<button>` clicks. Consequence, accepted: no URLs, no browser back button, no
shareable product links.

`api.js` wraps `fetch`, owns the base URL, and mints/reads the `cartId` UUID
from `localStorage`. Vite dev server proxies `/api` to `:5000`.

Pages render `div`, `ul`, `table`, `form`, `input`, `button` only. No
`className`, no style attributes, no CSS file.

## Testing

Mocha + Chai + `chai-http` against the real Express app, backed by a real local
MongoDB using a separate `mern-shop-test` database. `mongodb-memory-server` is
not authorized, so a local `mongod` must be running to test. `dropDatabase()`
runs in `beforeEach`.

```
"test":    "cross-env NODE_ENV=test MONGO_URI=mongodb://127.0.0.1:27017/mern-shop-test mocha --exit"
"test:ci": "cross-env NODE_ENV=test MONGO_URI=... mocha --reporter mocha-multi-reporters --reporter-options configFile=.mocharc-reporters.json --exit"
```

Backend only. Client pages are thin fetch-and-render and get no tests; adding a
jsdom setup is not justified at this size.

Development runs on `node --watch src/index.js` — `nodemon` is not authorized.

## Delivery

One branch and one PR per row, merged by the repo owner, squashed to a single
commit. Test-driven: a failing-test commit precedes its fix commit on the
branch, and the squash collapses them at merge.

| PR | Content |
|---|---|
| 1 | Server scaffold, `db.js`, error handler, Product model, seed, product routes + tests |
| 2 | User model, bcrypt-seeded user, login route + tests |
| 3 | Cart model + cart routes + tests |
| 4 | Order model + order routes + tests |
| 5 | Client scaffold, page switch, Products + ProductDetail |
| 6 | Login + Cart pages |
| 7 | Checkout + OrderDone |

## Out of scope

Registration, payment, admin CRUD, product search, pagination, product reviews,
stock decrement on order, order history page, styling of any kind.
