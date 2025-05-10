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

// ── Track Which *Items* We’ve Already Seen ────────────────────────────────────
const seenItemsMap = new Map()
//   Map<orderId, Set<lineItemId>>

// ── Polling Loop ─────────────────────────────────────────────────────────────
async function pollOnce() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  const limit       = 100
  let offset        = 0

  try {
    while (true) {
      // Expand only lineItems.name so we get both `li.id` and `li.name`
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

      // Only look at orders created in the last two hours
      const recent = elements.filter(o => o.createdTime >= twoHoursAgo)

      for (const o of recent) {
        const items = o.lineItems?.elements || []
        if (items.length === 0) continue  // no lineItems yet

        // Get (or init) the seen-items set for this order
        let seenSet = seenItemsMap.get(o.id)
        if (!seenSet) {
          seenSet = new Set()
          seenItemsMap.set(o.id, seenSet)
        }

        // Find any lineItems *this* poll that we haven't seen before
        const newOnes = items.filter(li => !seenSet.has(li.id))
        if (newOnes.length === 0) continue

        // Mark *all* current items as seen (so we don't re-emit duplicates)
        items.forEach(li => seenSet.add(li.id))

        // Merge states with existing DB record
        const cloverNames = items
          .map(li => li.name)
          .filter(n => typeof n === 'string' && n.length > 0)

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
        const finalItems = Array.from(nameToState, ([name, state]) => ({ name, state }))

        // Upsert the order document
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

        // Emit the update to clients, noting exactly which items were new
        await pusher.trigger('orders', 'order-updated', {
          orderId:   o.id,
          title:     o.title,
          items:     finalItems,
          newItems:  newOnes.map(li => li.name),
          state:     existing ? undefined : 'new',
          updatedAt: o.modifiedTime || o.updatedTime || o.createdTime
        })

        console.log(`→ Order ${o.id} updated with new items: ${newOnes.map(li => li.name).join(', ')}`)
      }

      // stop paging if we're done
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
  console.log('🚀 Starting Clover poller (every 1s, last 2h only)')
  await pollOnce()
  setInterval(pollOnce, 1000)
}

start().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
