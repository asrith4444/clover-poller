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
  console.error('❌ Missing required environment variables. Check your .env file.')
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
  console.log('✅ Connected to MongoDB (ikds collection)')
}

// ── Track Which *Line-Items* We’ve Already Seen ───────────────────────────────
const seenItemsMap = new Map()
// Map<orderId, Set<lineItemId>>

async function pollOnce() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  const limit       = 100
  let offset        = 0

  try {
    while (true) {
      // Expand only the name field on each lineItem
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
      if (elements.length === 0) break

      // Only orders created in the last 2h
      const recent = elements.filter(o => o.createdTime >= twoHoursAgo)

      for (const o of recent) {
        const items = o.lineItems?.elements || []
        if (items.length === 0) continue  // still no items

        // Get (or init) the seen-item set for this order
        let seenSet = seenItemsMap.get(o.id)
        if (!seenSet) {
          seenSet = new Set()
          seenItemsMap.set(o.id, seenSet)
        }

        // Which lineItems are brand-new this poll?
        const newOnes = items.filter(li => !seenSet.has(li.id))
        if (newOnes.length === 0) {
          // But *rebuild* DB anyway to catch item *deletions*
          // (we'll handle below)
        } else {
          // Mark only the *new* ones as seen
          newOnes.forEach(li => seenSet.add(li.id))
        }

        // ── Build finalItems from exactly what Clover reports ──
        // savedItems: [{ id, name, state }, ...]
        const col      = db.collection('ikds')
        const existing = await col.findOne(
          { orderId: o.id },
          { projection: { items: 1, state: 1 } }
        )
        const savedItems = existing?.items || []

        // Map from lineItemId -> previous state
        const idToState = new Map(
          savedItems.map(i => [i.id, i.state])
        )

        // For each current lineItem, carry over old state or default to "new"
        const finalItems = items.map(li => {
          const state = idToState.get(li.id) || 'new'
          return { id: li.id, name: li.name, state }
        })

        // ── Upsert into MongoDB ───────────────────────────────
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

        // ── Emit Pusher event ────────────────────────────────
        await pusher.trigger('orders', 'order-updated', {
          orderId:   o.id,
          title:     o.title,
          items:     finalItems,
          // let clients know which names arrived just now
          newItems:  newOnes.map(li => li.name),
          state:     existing ? undefined : 'new',
          updatedAt: o.modifiedTime || o.updatedTime || o.createdTime
        })

        console.log(
          `→ Order ${o.id} sync: [${finalItems.map(i=>i.name).join(', ')}] ` +
          (newOnes.length
            ? `(+ new: ${newOnes.map(li=>li.name).join(', ')})`
            : '')
        )
      }

      // break paging when done
      if (
        elements.length < limit ||
        elements[elements.length - 1].createdTime < twoHoursAgo
      ) {
        break
      }
      offset += limit
    }
  } catch (err) {
    console.error('❌ Poller error:', err)
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
