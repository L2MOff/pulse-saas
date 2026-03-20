require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Webhook Stripe → body RAW avant express.json()
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), handleWebhook);
app.use(express.json());

// ── PRICE IDs ─────────────────────────────────────────────────────────────────
const PRICE_IDS = {
  starter_monthly:  'price_XXXXXXXXXXXXXXXX',
  pro_monthly:      'price_YYYYYYYYYYYYYYYY',
  pro_annual:       'price_ZZZZZZZZZZZZZZZZ',
  business_monthly: 'price_WWWWWWWWWWWWWWWW',
};

const PLAN_CREDITS = { starter: 100, pro: 300, business: 99999 };

// ── HELPERS — initialisés à la demande ────────────────────────────────────────
function getStripe() {
  const Stripe = require('stripe');
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

function getSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    supabase_url: process.env.SUPABASE_URL ? 'set' : 'MISSING',
    stripe_key:   process.env.STRIPE_SECRET_KEY ? 'set' : 'MISSING',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. CRÉER UNE SESSION STRIPE CHECKOUT
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  const stripe   = getStripe();
  const supabase = getSupabase();
  const { userId, email, plan, annual = false } = req.body;

  if (!userId || !email || !plan)
    return res.status(400).json({ error: 'userId, email et plan sont requis.' });

  const priceKey = `${plan}_${annual ? 'annual' : 'monthly'}`;
  const priceId  = PRICE_IDS[priceKey] || PRICE_IDS[`${plan}_monthly`];

  if (!priceId)
    return res.status(400).json({ error: `Plan inconnu : ${plan}` });

  try {
    const { data: profile } = await supabase
      .from('profiles').select('stripe_customer_id').eq('id', userId).single();

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email, metadata: { supabase_user_id: userId },
      });
      customerId = customer.id;
      await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { supabase_user_id: userId, plan },
      },
      success_url: `${process.env.FRONTEND_URL}/app?checkout=success`,
      cancel_url:  `${process.env.FRONTEND_URL}/app?checkout=cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PORTAIL CLIENT STRIPE
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/customer-portal', async (req, res) => {
  const stripe   = getStripe();
  const supabase = getSupabase();
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requis.' });

  try {
    const { data: profile } = await supabase
      .from('profiles').select('stripe_customer_id').eq('id', userId).single();

    if (!profile?.stripe_customer_id)
      return res.status(404).json({ error: 'Aucun abonnement trouvé.' });

    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   profile.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/app`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('customer-portal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DÉDUIRE DES CRÉDITS
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/use-credits', async (req, res) => {
  const supabase = getSupabase();
  const { userId, amount = 2, contentType, brand, output } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requis.' });

  try {
    const { data: profile } = await supabase
      .from('profiles').select('credits, credits_used, plan').eq('id', userId).single();

    if (!profile) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (profile.credits < amount)
      return res.status(402).json({ error: 'Crédits insuffisants.', credits_remaining: profile.credits });

    await supabase.from('profiles').update({
      credits:      profile.credits - amount,
      credits_used: profile.credits_used + amount,
      updated_at:   new Date().toISOString(),
    }).eq('id', userId);

    await supabase.from('generations').insert({
      user_id: userId, content_type: contentType || 'unknown',
      brand: brand || '', output: output || '', credits_used: amount,
    });

    res.json({ credits_remaining: profile.credits - amount });
  } catch (err) {
    console.error('use-credits error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PROFIL UTILISATEUR
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/profile/:userId', async (req, res) => {
  const supabase = getSupabase();
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('first_name, last_name, email, plan, credits, credits_used, trial_end')
      .eq('id', req.params.userId).single();

    if (error) return res.status(404).json({ error: 'Profil introuvable.' });

    const trialDaysLeft = Math.max(
      0, Math.ceil((new Date(profile.trial_end) - new Date()) / (1000 * 60 * 60 * 24))
    );
    res.json({ ...profile, trial_days_left: trialDaysLeft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. WEBHOOK STRIPE
// ─────────────────────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const stripe   = getStripe();
  const supabase = getSupabase();
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const userId = obj.metadata?.supabase_user_id;
        const plan   = obj.metadata?.plan || 'pro';
        if (!userId) break;
        await supabase.from('profiles').update({
          plan, credits: PLAN_CREDITS[plan] || 300,
          stripe_subscription_id: obj.id, updated_at: new Date().toISOString(),
        }).eq('id', userId);
        await supabase.from('subscriptions').upsert({
          user_id: userId, plan, stripe_sub_id: obj.id, status: obj.status,
          current_period_end: new Date(obj.current_period_end * 1000).toISOString(),
        }, { onConflict: 'stripe_sub_id' });
        break;
      }
      case 'customer.subscription.deleted': {
        const userId = obj.metadata?.supabase_user_id;
        if (!userId) break;
        await supabase.from('profiles').update({ plan: 'trial', credits: 10, updated_at: new Date().toISOString() }).eq('id', userId);
        await supabase.from('subscriptions').update({ status: 'cancelled' }).eq('stripe_sub_id', obj.id);
        break;
      }
      case 'invoice.payment_succeeded': {
        const { data: profile } = await supabase.from('profiles').select('id, plan').eq('stripe_customer_id', obj.customer).single();
        if (profile) {
          await supabase.from('profiles').update({ credits: PLAN_CREDITS[profile.plan] || 300, credits_used: 0, updated_at: new Date().toISOString() }).eq('id', profile.id);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const { data: profile } = await supabase.from('profiles').select('id, email').eq('stripe_customer_id', obj.customer).single();
        if (profile) console.warn(`Paiement échoué pour ${profile.email}`);
        break;
      }
    }
  } catch (err) {
    console.error(`Erreur webhook ${event.type}:`, err);
  }

  res.json({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// DÉMARRAGE
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✦ PULSE API → http://localhost:${PORT}`));

module.exports = app;
