import RateLimit from '../models/rateLimit.js'

export async function incrementWindow(key, windowStart, expiresAt) {
  try {
    return await RateLimit.findOneAndUpdate(
      { key, windowStart },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: 'after', runValidators: true }
    )
  } catch (err) {
    if (err.code !== 11000) throw err
    return RateLimit.findOneAndUpdate(
      { key, windowStart },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: 'after', runValidators: true }
    )
  }
}
