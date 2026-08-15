import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcrypt'
import { connect } from './db.js'
import Product from './models/product.js'
import User from './models/user.js'

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

export const seedUser = { name: 'Demo User', email: 'demo@shop.test', password: 'demo1234' }

export async function seedUsers() {
  await User.deleteMany({})
  const passwordHash = await bcrypt.hash(seedUser.password, 10)
  return User.create({ name: seedUser.name, email: seedUser.email, passwordHash })
}

if (process.env.NODE_ENV !== 'test') {
  await connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-shop')
  await seedProducts()
  await seedUsers()
  await mongoose.disconnect()
  console.log(`seeded ${products.length} products and 1 user: ${seedUser.email} / ${seedUser.password}`)
}
