import 'dotenv/config'
import app from './app.js'
import { connect } from './db.js'

const port = process.env.PORT || 5001
const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-movies'

await connect(uri)
app.listen(port, () => console.log(`listening on ${port}`))
