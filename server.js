const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // put paywall.html in /public

// ---- Render environment variables ----
// PAYPAL_CLIENT_ID      your PayPal client ID
// PAYPAL_CLIENT_SECRET  your PayPal secret (never put this in the frontend)
// PAYPAL_ENV            "live" or "sandbox" (default: live)
// FREE_ACCESS_EMAILS    comma-separated, e.g. a@x.com,b@y.com
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = 'live',
  FREE_ACCESS_EMAILS = '',
} = process.env;

const PAYPAL_API =
  PAYPAL_ENV === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

const freeEmails = new Set(
  FREE_ACCESS_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);

async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal auth failed');
  return (await res.json()).access_token;
}

async function isSubscriptionActive(subscriptionID) {
  if (!subscriptionID) return false;
  const token = await getAccessToken();
  const res = await fetch(
    `${PAYPAL_API}/v1/billing/subscriptions/${encodeURIComponent(subscriptionID)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return false;
  const sub = await res.json();
  return sub.status === 'ACTIVE';
}

// Returns whether this user has Plus (free-access email OR active PayPal subscription)
app.post('/api/plus-status', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { subscriptionID } = req.body;

    if (email && freeEmails.has(email)) {
      return res.json({ plus: true, reason: 'free-access' });
    }
    if (await isSubscriptionActive(subscriptionID)) {
      return res.json({ plus: true, reason: 'subscription' });
    }
    res.json({ plus: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ plus: false, error: 'Server error' });
  }
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mr.Heart server running on ${PORT}`));
