# Clover Poller

A lightweight Node.js script that periodically fetches new orders (and their line-items) from the Clover API, upserts them into a MongoDB collection, and emits real-time order-updated events via Pusher.

⸻

## 🔍 Overview
	•	Fetch interval: configurable (defaults to every 1 second)
	•	Time window: only considers orders created in the last 2 hours
	•	Line-item tracking: tracks each line-item’s unique ID to handle duplicates, additions and deletions
	•	Storage: upserts into a MongoDB collection of your choice
	•	Real-time: broadcasts updates (including which items are brand-new) to clients over a Pusher channel

⸻

## ⚙️ Prerequisites
	•	Node.js v14 or later
	•	A running MongoDB instance (Atlas, local, or hosted)
	•	A Clover merchant account with a valid access token (sandbox or production)
	•	A Pusher account for real-time notifications

⸻

## 📦 Installation
	1.	Copy poller.js into your project directory.
	2.	Install dependencies:

`npm install node-fetch@2 pusher mongodb dotenv`


	3.	Create a .env file alongside poller.js:

# Clover API
CLOVER_BASE_URL=https://apisandbox.dev.clover.com
CLOVER_ACCESS_TOKEN=<your-clover-token>
CLOVER_MERCHANT_ID=<your-merchant-id>

# MongoDB
MONGODB_URI=<your-mongodb-connection-string>
MONGODB_DB=<your-database-name>

# Pusher
PUSHER_APP_ID=<your-pusher-app-id>
PUSHER_KEY=<your-pusher-key>
PUSHER_SECRET=<your-pusher-secret>
PUSHER_CLUSTER=<your-pusher-cluster>



⸻

🚀 Usage

Run the poller:

`node poller.js`

You should see logs like:

✅ Connected to MongoDB
🚀 Starting Clover poller (every 1s, last 2h only)
→ Order ABC123 sync: [Espresso, Latte] (+ new: Espresso, Latte)
→ Order XYZ789 sync: [Muffin] (+ new: Muffin)
…


⸻

🔧 Configuration
	•	Fetch frequency: modify the millisecond interval in

setInterval(pollOnce, 1000)


	•	Time window: adjust

const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000


	•	Page size: change

const limit = 100



⸻

📖 How It Works
	1.	Connect to MongoDB using the official driver.
	2.	Every N ms, fetch a page of orders created in the last 2 hours, with ?expand=lineItems.name.
	3.	Track each line-item by its unique id so that:
	•	Duplicate names are preserved
	•	Newly added items get detected on subsequent polls
	•	Removed items are dropped when rebuilding the list
	4.	Upsert the order document in MongoDB, merging in prior item states (new, ready, completed).
	5.	Emit a Pusher event (orders:order-updated) containing:
	•	orderId, title
	•	The current items[] array
	•	newItems[] (names of items that appeared this poll)

⸻

🛠 Extending
	•	Error handling: add retry/backoff logic for network failures.
	•	Webhooks: switch polling to Clover webhooks to reduce API usage.
	•	Scaling: shard by offset/page or run multiple instances for high-volume merchants.

⸻

📜 License

MIT