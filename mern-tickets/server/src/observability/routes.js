import { Router } from 'express'
import mongoose from 'mongoose'
import { renderMetrics } from './metrics.js'
import { isReady } from './health.js'

const router = Router()

router.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' })
})

router.get('/readyz', (req, res) => {
  const ready = isReady() && mongoose.connection.readyState === 1
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'not ready' })
})

router.get('/metrics', (req, res) => {
  res.status(200).set('Content-Type', 'text/plain; version=0.0.4').send(renderMetrics())
})

export default router
