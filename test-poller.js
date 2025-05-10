// test-poller.js
require('dotenv').config()
const fetch         = require('node-fetch')
const { MongoClient } = require('mongodb')

async function main() {
  const {
    CLOVER_BASE_URL = 'https://sandbox.dev.clover.com',
    CLOVER_ACCESS_TOKEN,
    CLOVER_MERCHANT_ID,
    MONGODB_URI,
    MONGODB_DB
  } = process.env

  if (
    !CLOVER_ACCESS_TOKEN ||
    !CLOVER_MERCHANT_ID  ||
    !MONGODB_URI         ||
    !MONGODB_DB
  ) {
    console.error('❌ Missing environment variables')
    process.exit(1)
  }

  // Connect to MongoDB
  const client = new MongoClient(MONGODB_URI, {
    useNewUrlParser:    true,
    useUnifiedTopology: true
  })
  await client.connect()
  const col = client.db(MONGODB_DB).collection('ikds')
  console.log('✅ Connected to MongoDB')

  // Fetch last 10 orders
  const url =
    `${CLOVER_BASE_URL}/v3/merchants/${CLOVER_MERCHANT_ID}/orders` +
    `?limit=10&orderBy=createdTime%20DESC&expand=lineItems`

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${CLOVER_ACCESS_TOKEN}` }
  })
  if (!resp.ok) {
    console.error('⚠️ Clover fetch failed:', resp.status, await resp.text())
    process.exit(1)
  }

  const { elements = [] } = await resp.json()
  console.log(`🚀 Fetched ${elements.length} orders`)

  let changed = 0
  for (const o of elements) {
    // Merge existing item states
    const cloverNames = (o.lineItems?.elements || [])
      .map(li => li.name || li.item?.name)
      .filter(n => !!n)

    const existing   = await col.findOne(
      { orderId: o.id },
      { projection: { items: 1 } }
    )
    const savedItems = existing?.items || []
    const nameToState = new Map(savedItems.map(i => [i.name, i.state]))
    cloverNames.forEach(name => {
      if (!nameToState.has(name)) nameToState.set(name, 'new')
    })
    const finalItems = cloverNames.length
      ? Array.from(nameToState, ([name, state]) => ({ name, state }))
      : savedItems

    // Upsert: **only** set `state` on insert
    const result = await col.updateOne(
      { orderId: o.id },
      {
        $set: {
          title:     o.title || '',
          items:     finalItems,
          updatedAt: new Date(o.modifiedTime)
        },
        $setOnInsert: {
          orderId:   o.id,
          state:     'new',                     // initial order state
          createdAt: new Date(o.createdTime)
        }
      },
      { upsert: true }
    )

    console.log(
      `• Order ${o.id}: upserted=${result.upsertedCount}, modified=${result.modifiedCount}`
    )
    if (result.upsertedCount || result.modifiedCount) changed++
  }

  console.log(`✅ ${changed} of ${elements.length} orders were upserted/updated`)
  await client.close()
}

main().catch(err => {
  console.error('❌ Semi-poller error:', err)
  process.exit(1)
})
