import mongoose from 'mongoose'

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
      {
        _id: false,
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        qty: { type: Number, required: true, min: 1 }
      }
    ],
    total: { type: Number, required: true, min: 0 },
    customer: {
      name: { type: String, required: true },
      email: { type: String, required: true },
      address: { type: String, required: true }
    },
    status: { type: String, default: 'pending' },
    fraud: {
      score: { type: Number, default: 0 },
      decision: { type: String, default: 'allow' },
      reasons: { type: [String], default: [] }
    }
  },
  { timestamps: true }
)

orderSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.fraud
    delete ret.__v
    return ret
  }
})

export default mongoose.model('Order', orderSchema)
