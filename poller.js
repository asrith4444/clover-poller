// poller.js
require('dotenv').config()
const fetch           = require('node-fetch')  // v2.x
const Pusher          = require('pusher')
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
  console.log('✅ Connected to MongoDB')
}

const ignoreItems = ['Bottled Water', 'Powerade', 'Powerade Big', 'Coke Soda','Mango Nectur']

// ── Track Which *Line-Items* We’ve Already Seen ───────────────────────────────
const seenItemsMap = new Map()  // Map<orderId, Set<lineItemId>>

// ── Core poll logic ───────────────────────────────────────────────────────────
async function pollOnce() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  const limit       = 100
  let offset        = 0

  while (true) {
    // 1) Pull a page of orders, expanding only lineItems.name
    const url =
      `${CLOVER_BASE_URL}/v3/merchants/${CLOVER_MERCHANT_ID}/orders` +
      `?expand=lineItems.name&limit=${limit}&offset=${offset}`

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${CLOVER_ACCESS_TOKEN}` }
    })
    if (!resp.ok) {
      const body = await resp.text()
      console.error('⚠️ Clover fetch failed:', resp.status, body)
      return
    }

    const { elements = [] } = await resp.json()
    if (elements.length === 0) break

    // 2) Only consider orders in the last 2h
    const recent = elements.filter(o => o.createdTime >= twoHoursAgo)

    for (const o of recent) {
      const items = o.lineItems?.elements || []
      if (items.length === 0) continue  // no items yet

      // 3) Init or retrieve this order’s seen-ID set
      let seenSet = seenItemsMap.get(o.id)
      if (!seenSet) {
        seenSet = new Set()
        seenItemsMap.set(o.id, seenSet)
      }

      // 4) Identify newly-arrived line-items this poll
      const newOnes = items.filter(li => !seenSet.has(li.id))
      // Mark new ones seen for next time
      newOnes.forEach(li => seenSet.add(li.id))

      // 5) Build finalItems exactly as Clover reports, carrying over old states
      const col      = db.collection('ikds')
      const existing = await col.findOne(
        { orderId: o.id },
        { projection: { items: 1, state: 1 } }
      )
      const saved     = existing?.items || []
      const idToState = new Map(saved.map(i => [i.id, i.state]))

      const finalItems = items.map(li => ({
        id:    li.id,
        name:  li.name,
        state: idToState.get(li.id) || 'new'
      }))

      // Filter out ignored items
      const filteredItems = finalItems.filter(li => !ignoreItems.includes(li.name))



      // 6) Upsert into MongoDB
      await col.updateOne(
        { orderId: o.id },
        {
          $set: {
            title:     o.title || '',
            items:     filteredItems,
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

      // 7) **Only** emit if there were actually new line-items
      if (newOnes.length > 0) {
        await pusher.trigger('orders', 'order-updated', {
          orderId:  o.id,
          title:    o.title,
          items:    finalItems,
          newItems: newOnes.map(li => li.name),
          state:    existing ? undefined : 'new',
          updatedAt: o.modifiedTime || o.updatedTime || o.createdTime
        })

        console.log(
          `→ Order ${o.id} updated: [${finalItems.map(i => i.name).join(', ')}] ` +
          `(+ new: ${newOnes.map(li => li.name).join(', ')})`
        )
      }
    }

    // 8) Advance pagination or break
    if (
      elements.length < limit ||
      elements[elements.length - 1].createdTime < twoHoursAgo
    ) {
      break
    }
    offset += limit
  }
}

// ── Time‐gated scheduling ──────────────────────────────────────────────────────
async function schedule() {
  try {
    // Compute current EDT hour (UTC-4)
    const now     = new Date()
    const utcHour = now.getUTCHours()
    const edtHour = (utcHour + 24 - 4) % 24

    // Only run between 11:00 (11) and 23:59 EDT
    if (edtHour >= 11 && edtHour < 24) {
      await pollOnce()
    } else {
      console.log(`⏸️  Outside polling hours (EDT ${edtHour}:00), skipping…`)
    }
  } catch (err) {
    console.error('❌ Error in scheduled run:', err)
  } finally {
    // Schedule next run in 1s
    setTimeout(schedule, 1000)
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  await initDb()
  console.log('🚀 Clover poller started; active 11 AM–midnight EDT')
  schedule()
}

start().catch(err => {
  console.error('Fatal error on startup:', err)
  process.exit(1)
})
