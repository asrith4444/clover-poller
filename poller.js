// poller.js
require('dotenv').config()
const fetch          = require('node-fetch')        // v2.x
const Pusher         = require('pusher')
const { MongoClient } = require('mongodb')

// ── Env & Validation ──────────────────────────────────────────────────────────
const {
  CLOVER_BASE_URL     = 'https://apisandbox.dev.clover.com',
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

// ── In‐memory Dedupe & Polling ────────────────────────────────────────────────
// Track which orders we’ve fully processed
const seenOrders = new Set()

async function pollOnce() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  const limit       = 100
  let offset        = 0
  let anyNew        = false

  try {
    while (true) {
      // Fetch a page of orders, expanding both the container and each item’s details
      const url =
        `${CLOVER_BASE_URL}/v3/merchants/${CLOVER_MERCHANT_ID}/orders` +
        `?expand=lineItems%2ClineItems.item&limit=${limit}&offset=${offset}`

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${CLOVER_ACCESS_TOKEN}` }
      })
      if (!resp.ok) {
        console.error('⚠️  Clover fetch failed:', resp.status, await resp.text())
        break
      }

      const { elements = [] } = await resp.json()
      if (elements.length === 0) break

      // Only keep orders created in the last 2 hours
      const recent = elements.filter(o => o.createdTime >= twoHoursAgo)

      for (const o of recent) {
        // Skip orders we've already processed
        if (seenOrders.has(o.id)) continue

        // Extract line-item names: either li.name or expanded li.item.name
        const cloverNames = (o.lineItems?.elements || [])
          .map(li => li.name || li.item?.name)
          .filter(n => typeof n === 'string' && n.length > 0)

        // If no items yet, defer processing until a later poll
        if (cloverNames.length === 0) {
          continue
        }

        // Now mark as seen so we don't re-process
        seenOrders.add(o.id)
        anyNew = true

        // Merge with existing DB states
        const col      = db.collection('ikds')
        const existing = await col.findOne(
          { orderId: o.id },
          { projection: { items: 1 } }
        )
        const savedItems = existing?.items || []
        const nameToState = new Map(savedItems.map(i => [i.name, i.state]))
        cloverNames.forEach(name => {
          if (!nameToState.has(name)) {
            nameToState.set(name, 'new')
          }
        })
        const finalItems = cloverNames.length
          ? Array.from(nameToState, ([name, state]) => ({ name, state }))
          : savedItems

        // Upsert into MongoDB
        await col.updateOne(
          { orderId: o.id },
          {
            $set: {
              title:     o.title || '',
              items:     finalItems,
              updatedAt: new Date(o.modifiedTime || o.updatedTime || o.createdTime)
            },
            $setOnInsert: {
              orderId:   o.id,
              state:     'new',
              createdAt: new Date(o.createdTime)
            }
          },
          { upsert: true }
        )

        // Emit real-time event via Pusher
        await pusher.trigger('orders', 'order-updated', {
          orderId:   o.id,
          title:     o.title,
          items:     finalItems,
          state:     existing ? undefined : 'new',
          updatedAt: o.modifiedTime || o.updatedTime || o.createdTime
        })

        console.log(`→ Emitted new order ${o.id}`)
      }

      // Stop paging if fewer than limit or last item older than 2h
      if (
        elements.length < limit ||
        elements[elements.length - 1].createdTime < twoHoursAgo
      ) {
        break
      }
      offset += limit
    }

    if (!anyNew) {
      // no new orders this cycle
    }
  } catch (err) {
    console.error('❌  Poller error:', err)
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  await initDb()
  console.log('🚀  Starting Clover poller (every 1s, last 2h only)')
  await pollOnce()
  setInterval(pollOnce, 1000)
}

start().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})