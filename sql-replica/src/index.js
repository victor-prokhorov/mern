import 'dotenv/config'
import app from './app.js'
import { tick } from './services/documents.js'

const port = process.env.PORT || 5007
const tickMs = Number(process.env.TICK_MS) || 1000

app.listen(port, () => console.log(`listening on ${port}`))

setInterval(() => {
  tick().catch((err) => console.error('replica tick failed', err))
}, tickMs)
