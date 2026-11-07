const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // index.html, paywall.html, images

// ---- Render environment variables ----
// SUPABASE_URL                 https://xxxx.supabase.co
// SUPABASE_ANON_KEY            public anon key (safe for the browser)
// SUPABASE_SERVICE_ROLE_KEY    secret key (server only, never in the browser)
// PAYPAL_CLIENT_ID             PayPal client ID
// PAYPAL_CLIENT_SECRET         PayPal secret
// PAYPAL_ENV                   "live" or "sandbox" (default: live)
// FREE_ACCESS_EMAILS           comma-separated, e.g. a@x.com,b@y.com
const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = 'live',
  FREE_ACCESS_EMAILS = '',
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAYPAL_API =
  PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

const freeEmails = new Set(
  FREE_ACCESS_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);

// ---------- PayPal ----------
async function getPaypalToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal auth failed');
  return (await res.json()).access_token;
}

// Returns the PayPal status (ACTIVE, CANCELLED, SUSPENDED, EXPIRED...) or null if not found
async function getPaypalStatus(subscriptionID) {
  if (!subscriptionID) return null;
  const token = await getPaypalToken();
  const res = await fetch(
    `${PAYPAL_API}/v1/billing/subscriptions/${encodeURIComponent(subscriptionID)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return (await res.json()).status;
}

// ---------- Auth ----------
async function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid session' });
  req.user = data.user;
  next();
}

// ---------- Plus status: free email OR active PayPal subscription ----------
async function getPlus(user) {
  const email = (user.email || '').toLowerCase();
  if (email && freeEmails.has(email)) return { plus: true, reason: 'free-access' };

  const { data: row } = await supabase
    .from('subscriptions').select('*').eq('user_id', user.id).maybeSingle();
  if (!row) return { plus: false };

  // Re-check with PayPal so cancellations are picked up automatically
  const status = await getPaypalStatus(row.paypal_subscription_id);
  if (status && status !== row.status) {
    await supabase.from('subscriptions')
      .update({ status, updated_at: new Date().toISOString() }).eq('user_id', user.id);
  }
  return { plus: (status || row.status) === 'ACTIVE', reason: 'subscription' };
}

const toProfile = (p) => ({
  xp: p.xp, streak: p.streak, best: p.best, total: p.total,
  last: p.last_workout, hist: p.hist || [],
});

// ---------- Routes ----------
app.get('/api/config', (req, res) =>
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY })
);

app.get('/api/me', requireUser, async (req, res) => {
  try {
    let { data: profile } = await supabase
      .from('profiles').select('*').eq('id', req.user.id).maybeSingle();
    if (!profile) {
      const ins = await supabase.from('profiles')
        .insert({ id: req.user.id, email: req.user.email }).select().single();
      profile = ins.data;
    }
    const plus = await getPlus(req.user);
    res.json({ profile: toProfile(profile), ...plus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/progress', requireUser, async (req, res) => {
  try {
    const b = req.body || {};
    const int = (v) => Math.max(0, Math.min(1000000, parseInt(v, 10) || 0));
    const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const hist = (Array.isArray(b.hist) ? b.hist : []).filter(isDate).slice(-90);
    const { error } = await supabase.from('profiles').upsert({
      id: req.user.id,
      email: req.user.email,
      xp: int(b.xp), streak: int(b.streak), best: int(b.best), total: int(b.total),
      last_workout: isDate(b.last) ? b.last : null,
      hist,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save progress' });
  }
});

// Called by the paywall after PayPal approves a subscription
app.post('/api/subscription', requireUser, async (req, res) => {
  try {
    const subscriptionID = String((req.body || {}).subscriptionID || '');
    const status = await getPaypalStatus(subscriptionID);
    if (status !== 'ACTIVE') return res.json({ plus: false, status });

    const { error } = await supabase.from('subscriptions').upsert({
      user_id: req.user.id,
      paypal_subscription_id: subscriptionID,
      status,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    res.json({ plus: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ plus: false, error: 'Server error' });
  }
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mr.Heart server running on ${PORT}`));
