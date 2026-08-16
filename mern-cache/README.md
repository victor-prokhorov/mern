# mern-cache

A tiny product-catalogue API built to teach one thing properly: caching. A hand-built in-process cache sits in front of a deliberately slow MongoDB "origin", so cache-aside, TTL expiry, invalidation-on-write, negative caching, and single-flight stampede protection are all visible in code rather than hidden inside Redis. API only, no client. Layering matches `mern-shop/server` and `mern-tickets/server`: `routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every Mongoose call, and the cache mechanism lives in `src/cache/`.

## Requirements

- Node 20+
- A local MongoDB on `mongodb://127.0.0.1:27017`

## Run it

```bash
cd server
npm install
cp .env.example .env
npm run seed
npm run dev
```

API on `http://localhost:5006`. `npm run seed` inserts five products. The port is distinct from every other app in the repo, so `mern-cache` runs side by side with the rest on their default `.env`s.

## Tests

```bash
cd server
npm test
npm run test:ci
```

`npm test` drops and rebuilds the `mern-cache-test` database on every run, so a local `mongod` (or the repo's `mern-mongo` Docker container) must be reachable. The cache-mechanism tests are pure in-process unit tests and need no database; the HTTP wiring and seed tests do. `test:ci` additionally writes JUnit XML to `server/test-results/results.xml`.

## The guide

- [`server/src/cache/README.md`](server/src/cache/README.md) — the caching guide: cache-aside vs write-through/write-behind, TTL as a staleness bound versus explicit invalidation, negative caching, the cache stampede and single-flight coalescing, HTTP caching (`Cache-Control`/`ETag`/`304`/CDN) and how its ETag differs from the write-side ETag in `mern-tickets`, plus the AWS/GCP mapping to ElastiCache/MemoryDB/DAX and Memorystore/Cloud CDN.

## Endpoints

- `GET /api/products` — list all products (uncached).
- `GET /api/products/:id` — cache-aside read; sets an `X-Cache` header of `origin`, `cache`, `coalesced`, or `negative`.
- `POST /api/products` — create a product.
- `PATCH /api/products/:id` — update a product and invalidate its cache entry.
- `GET /api/cache/stats` — `{ size, originReads }`, the proof surface for cache hits.
- `POST /api/cache/reset` — clear the cache and zero the origin-call counter (a teaching aid, not a production endpoint).

## Config

`.env.example` covers `PORT` and `MONGO_URI`, plus three commented knobs: `CACHE_TTL_MS` (positive-entry TTL, default 30s), `CACHE_NEGATIVE_TTL_MS` (negative-entry TTL, default 5s), and `ORIGIN_DELAY_MS` (the artificial origin latency that makes single-flight observable, default 15ms).
