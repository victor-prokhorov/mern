# mern-shop

Minimal MERN ecommerce, built to practice the stack. No CSS, no styling — raw
HTML from React.

Every path below, and every path in `docs/`, is relative to this directory.

## Requirements

- Node 20+
- A local MongoDB on `mongodb://127.0.0.1:27017`

## Layout

```
client/   React + Vite, no router, raw HTML tags
server/   Express + Mongoose, layered router / controller / service / repository
docs/     design spec and implementation plans
```

## Server

```bash
cd server
npm install
cp .env.example .env
npm run seed
npm run dev
```

API on `http://localhost:5000`.

## Client

```bash
cd client
npm install
npm run dev
```

Client on `http://localhost:5173`, proxying `/api` to the server on `:5000`.

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
