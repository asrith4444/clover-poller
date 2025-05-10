// poller.js
require('dotenv').config();
const fetch       = require('node-fetch');      // v2.x
const Pusher      = require('pusher');
const { MongoClient } = require('mongodb');

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
} = process.env;

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
  console.error('❌ Missing required environment variables. Check your .env file.');
  process.exit(1);
}

// ── Pusher & MongoDB Setup ─────────────────────────────────────────────────────
const pusher = new Pusher({
  appId:   PUSHER_APP_ID,
  key:     PUSHER_KEY,
  secret:  PUSHER_SECRET,
  cluster: PUSHER_CLUSTER,
  useTLS:  true
});

const mongoClient = new MongoClient(MONGODB_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true
});

let db;
async function initDb() {
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  console.log('✅ Connected to MongoDB (ikds collection)');
}

// ── In‐memory Dedupe & Polling ────────────────────────────────────────────────
// Track which orders we’ve already emitted to avoid duplicates
const seenOrders = new Set();

async function pollOnce() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const limit       = 100;
  let offset        = 0;
  let anyNew        = false;

  try {
    while (true) {
      // 1) Fetch a page of orders, expanding all lineItems
      const url =
        `${CLOVER_BASE_URL}/v3/merchants/${CLOVER_MERCHANT_ID}/orders` +
        `?expand=lineItems&limit=${limit}&offset=${offset}`;

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${CLOVER_ACCESS_TOKEN}` }
      });
      if (!resp.ok) {
        console.error('⚠️  Clover fetch failed:', resp.status, await resp.text());
        break;
      }

      const { elements = [] } = await resp.json();
      if (!elements.length) break;

      // 2) Only keep orders from the last 2 hours
      const recent = elements.filter(o => o.createdTime >= twoHoursAgo);

      // 3) Process each new, unique order
      for (const o of recent) {
        if (seenOrders.has(o.id)) continue;
        seenOrders.add(o.id);
        anyNew = true;

        // ── Merge item states ───────────────────────────────
        const cloverNames = (o.lineItems?.elements || [])
          .map(li => li.name || li.item?.name)
          .filter(n => typeof n === 'string' && n.length > 0);

        const col      = db.collection('ikds');
        const existing = await col.findOne(
          { orderId: o.id },
          { projection: { items: 1, state: 1 } }
        );
        const savedItems = existing?.items || [];
        const nameToState = new Map(savedItems.map(i => [i.name, i.state]));

        // New items start as "new"
        cloverNames.forEach(name => {
          if (!nameToState.has(name)) {
            nameToState.set(name, 'new');
          }
        });

        // Final items list
        const finalItems = cloverNames.length
          ? Array.from(nameToState, ([name, state]) => ({ name, state }))
          : savedItems;

        // ── Upsert order document ───────────────────────────
        const result = await col.updateOne(
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
        );

        // ── Emit Pusher event ──────────────────────────────
        await pusher.trigger('orders', 'order-updated', {
          orderId:   o.id,
          title:     o.title,
          items:     finalItems,
          // if it's brand-new in the DB, let clients know state="new"
          state:     existing ? undefined : 'new',
          updatedAt: o.modifiedTime || o.updatedTime || o.createdTime
        });

        console.log(`→ Emitted new order ${o.id}`);
      }

      // 4) Pagination break: fewer than limit OR last record older than 2h
      if (
        elements.length < limit ||
        elements[elements.length - 1].createdTime < twoHoursAgo
      ) {
        break;
      }
      offset += limit;
    }

    if (!anyNew) {
      //console.log('— no new orders in the last 2 hours');
    }
  } catch (err) {
    console.error('❌ Poller error:', err);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  await initDb();
  console.log('🚀 Starting Clover poller (every 1s, last 2 h only)');
  // Initial run
  await pollOnce();
  // Re-run every 1 second
  setInterval(pollOnce, 1000);
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
