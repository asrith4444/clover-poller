// poller.js
require('dotenv').config()
const fetch = require('node-fetch')        // v2.x
const Pusher = require('pusher')
const { MongoClient } = require('mongodb')

// ── Env & Validation ──────────────────────────────────────────────────────────
const {
  CLOVER_BASE_URL = 'https://apisandbox.dev.clover.com',
  CLOVER_ACCESS_TOKEN,
  CLOVER_MERCHANT_ID,
  MONGODB_URI,
  MONGODB_DB,
  PUSHER_APP_ID,
  PUSHER_KEY,
  PUSHER_SECRET,
  PUSHER_CLUSTER
} = process.env

if (
  !CLOVER_ACCESS_TOKEN ||
  !CLOVER_MERCHANT_ID  ||
  !MONGODB_URI         ||
  !MONGODB_DB          ||
  !PUSHER_APP_ID       ||
  !PUSHER_KEY          ||
  !PUSHER_SECRET       ||
  !PUSHER_CLUSTER
) {
  console.error('❌  Missing required environment variables. Check your .env file.')
  process.exit(1)
}

// ── Pusher & MongoDB Setup ─────────────────────────────────────────────────────
const pusher = new Pusher({
  appId:   PUSHER_APP_ID,
  key:     PUSHER_KEY,
  secret:  PUSHER_SECRET,
  cluster: PUSHER_CLUSTER,
  useTLS:  true
})

const mongoClient = new MongoClient(MONGODB_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true
})

let db
async function initDb() {
  await mongoClient.connect()
  db = mongoClient.db(MONGODB_DB)
  console.log('✅  Connected to MongoDB (ikds collection)')
}

// ── In-memory Dedupe & Polling ────────────────────────────────────────────────
// Remember which orders we've already emitted
const seenOrders = new Set()

async function pollOnce() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  const limit       = 100
  let offset        = 0
  let anyNew        = false

  try {
    // Paginate through orders
    while (true) {
      const url =
        `${CLOVER_BASE_URL}/v3/merchants/${CLOVER_MERCHANT_ID}/orders` +
        `?expand=lineItems.name&limit=${limit}&offset=${offset}`

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${CLOVER_ACCESS_TOKEN}` }
      })
      if (!resp.ok) {
        console.error('⚠️  Clover fetch failed:', resp.status, await resp.text())
        break
      }

      const { elements = [] } = await resp.json()
      if (!elements.length) break

      // Filter to only orders created in the last 2 hours
      const recent = elements.filter(o => o.createdTime >= twoHoursAgo)

      // Process each new, unique order
      for (const o of recent) {
        if (seenOrders.has(o.id)) continue
        seenOrders.add(o.id)
        anyNew = true

        // Merge item‐states
        const cloverNames = (o.lineItems?.elements || []).map(li => li.name)
        const col         = db.collection('ikds')
        const existing    = await col.findOne(
          { orderId: o.id },
          { projection: { items: 1 } }
        )
        const savedItems  = existing?.items || []
        const nameToState = new Map(savedItems.map(i => [i.name, i.state]))
        cloverNames.forEach(name => {
          if (!nameToState.has(name)) nameToState.set(name, 'new')
        })
        const finalItems = cloverNames.length
          ? Array.from(nameToState, ([name, state]) => ({ name, state }))
          : savedItems

        // Upsert in ikds
        await col.updateOne(
          { orderId: o.id },
          {
            $set: {
              title:     o.title || '',
              items:     finalItems,
              updatedAt: new Date(o.updatedTime)
            },
            $setOnInsert: {
              orderId:   o.id,
              state:     'new',
              createdAt: new Date(o.createdTime)
            }
          },
          { upsert: true }
        )

        // Emit via Pusher
        await pusher.trigger('orders', 'order-updated', {
          orderId:   o.id,
          title:     o.title,
          items:     finalItems,
          state:     existing ? undefined : 'new',
          updatedAt: o.updatedTime
        })

        console.log(`→ Emitted new order ${o.id}`)
      }

      // Stop if:
      //  • we got fewer than `limit`, or
      //  • the last element is older than 2h
      if (
        elements.length < limit ||
        elements[elements.length - 1].createdTime < twoHoursAgo
      ) break

      offset += limit
    }

    if (!anyNew) console.log('— no new orders in the last 2 hours')
  } catch (err) {
    console.error('❌  Poller error:', err)
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  await initDb()
  console.log('🚀  Starting Clover poller (500 ms interval, last 2 hrs only)')
  pollOnce()
  setInterval(pollOnce, 1000)
}

start().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
