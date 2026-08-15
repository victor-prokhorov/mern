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
