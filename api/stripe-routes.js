/**
 * PULSE — API Backend Stripe + Supabase
 * ======================================
 * Stack : Node.js + Express
 * Deploy: Vercel / Railway / Render
 *
 * Installation :
 *   npm install express stripe @supabase/supabase-js dotenv cors
 *
 * Variables d'environnement requises (.env) :
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   ← clé "service_role" (pas anon !)
 *   STRIPE_SECRET_KEY      ← sk_live_... ou sk_test_...
 *   STRIPE_WEBHOOK_SECRET  ← whsec_... (depuis Stripe Dashboard > Webhooks)
 *   FRONTEND_URL           ← https://votre-domaine.fr
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const Stripe     = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Supabase avec la clé service_role (accès admin, côté serveur uniquement)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// IMPORTANT : le webhook Stripe a besoin du body RAW (avant json())
// donc on le déclare AVANT express.json()
app.post(
  '/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

// Toutes les autres routes utilisent JSON
app.use(express.json());

// ── PRICE IDs ─────────────────────────────────────────────────────────────────
// 🔧 Remplacez par vos vrais Price IDs depuis Stripe Dashboard > Products
const PRICE_IDS = {
  starter_monthly:  'price_XXXXXXXXXXXXXXXX',
  pro_monthly:      'price_YYYYYYYYYYYYYYYY',
  pro_annual:       'price_ZZZZZZZZZZZZZZZZ',
  business_monthly: 'price_WWWWWWWWWWWWWWWW',
};

const PLAN_CREDITS = {
  starter:  100,
  pro:      300,
  business: 99999, // illimité
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. CRÉER UNE SESSION STRIPE CHECKOUT
//    Appelé depuis app.html quand l'utilisateur clique "Activer mon abonnement"
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  const { userId, email, plan, annual = false } = req.body;

  if (!userId || !email || !plan) {
    return res.status(400).json({ error: 'userId, email et plan sont requis.' });
  }

  const priceKey = `${plan}_${annual ? 'annual' : 'monthly'}`;
  const priceId  = PRICE_IDS[priceKey] || PRICE_IDS[`${plan}_monthly`];

  if (!priceId) {
    return res.status(400).json({ error: `Plan inconnu : ${plan}` });
  }

  try {
    // Récupérer ou créer le Stripe Customer
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId },
      });
      customerId = customer.id;

      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    // Créer la session Checkout avec 14 jours d'essai
    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { supabase_user_id: userId, plan },
      },
      success_url: `${process.env.FRONTEND_URL}/app.html?checkout=success`,
      cancel_url:  `${process.env.FRONTEND_URL}/app.html?checkout=cancel`,
      // Pré-remplir l'email
      customer_email: customerId ? undefined : email,
      // Collect tax automatiquement (optionnel)
      // automatic_tax: { enabled: true },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PORTAIL CLIENT STRIPE
//    Permet à l'utilisateur de gérer sa carte, annuler, changer de plan
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/customer-portal', async (req, res) => {
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ error: 'userId requis.' });

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.stripe_customer_id) {
      return res.status(404).json({ error: 'Aucun abonnement trouvé.' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   profile.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/app.html`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('customer-portal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DÉDUIRE DES CRÉDITS après une génération IA
//    Appelé depuis app.html après chaque appel à l'API Anthropic
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/use-credits', async (req, res) => {
  const { userId, amount = 2, contentType, brand, output } = req.body;

  if (!userId) return res.status(400).json({ error: 'userId requis.' });

  try {
    // Récupérer les crédits actuels
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('credits, credits_used, plan')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    if (profile.credits < amount) {
      return res.status(402).json({
        error: 'Crédits insuffisants.',
        credits_remaining: profile.credits,
      });
    }

    // Déduire les crédits
    await supabase
      .from('profiles')
      .update({
        credits:      profile.credits - amount,
        credits_used: profile.credits_used + amount,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', userId);

    // Sauvegarder la génération dans l'historique
    await supabase.from('generations').insert({
      user_id:      userId,
      content_type: contentType || 'unknown',
      brand:        brand || '',
      output:       output || '',
      credits_used: amount,
    });

    res.json({ credits_remaining: profile.credits - amount });
  } catch (err) {
    console.error('use-credits error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. RÉCUPÉRER LE PROFIL UTILISATEUR (crédits, plan, etc.)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/profile/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('first_name, last_name, email, plan, credits, credits_used, trial_end')
      .eq('id', userId)
      .single();

    if (error) return res.status(404).json({ error: 'Profil introuvable.' });

    // Calculer les jours d'essai restants
    const trialEnd      = new Date(profile.trial_end);
    const now           = new Date();
    const trialDaysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));

    res.json({ ...profile, trial_days_left: trialDaysLeft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. WEBHOOK STRIPE
//    Stripe appelle cette route automatiquement pour chaque événement
//    (paiement réussi, abonnement annulé, etc.)
//    🔧 Enregistrez l'URL dans : Stripe Dashboard > Developers > Webhooks
//    URL : https://votre-api.vercel.app/api/stripe-webhook
// ─────────────────────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  try {
    switch (event.type) {

      // ── Abonnement créé ou mis à jour ──────────────────────────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const userId = obj.metadata?.supabase_user_id;
        const plan   = obj.metadata?.plan || 'pro';
        if (!userId) break;

        await supabase.from('profiles').update({
          plan,
          credits:                 PLAN_CREDITS[plan] || 300,
          stripe_subscription_id:  obj.id,
          updated_at:              new Date().toISOString(),
        }).eq('id', userId);

        await supabase.from('subscriptions').upsert({
          user_id:             userId,
          plan,
          stripe_sub_id:       obj.id,
          status:              obj.status,
          current_period_end:  new Date(obj.current_period_end * 1000).toISOString(),
        }, { onConflict: 'stripe_sub_id' });

        console.log(`✓ Abonnement ${plan} activé pour user ${userId}`);
        break;
      }

      // ── Abonnement résilié ─────────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const userId = obj.metadata?.supabase_user_id;
        if (!userId) break;

        await supabase.from('profiles').update({
          plan:       'trial',
          credits:    10,
          updated_at: new Date().toISOString(),
        }).eq('id', userId);

        await supabase.from('subscriptions').update({ status: 'cancelled' })
          .eq('stripe_sub_id', obj.id);

        console.log(`⚠ Abonnement résilié pour user ${userId}`);
        break;
      }

      // ── Paiement réussi (renouvellement mensuel) ───────────────────────────
      case 'invoice.payment_succeeded': {
        const customerId = obj.customer;
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, plan')
          .eq('stripe_customer_id', customerId)
          .single();

        if (profile) {
          // Renouveler les crédits chaque mois
          await supabase.from('profiles').update({
            credits:      PLAN_CREDITS[profile.plan] || 300,
            credits_used: 0,
            updated_at:   new Date().toISOString(),
          }).eq('id', profile.id);

          console.log(`✓ Crédits renouvelés pour user ${profile.id} (${profile.plan})`);
        }
        break;
      }

      // ── Paiement échoué ────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const customerId = obj.customer;
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, email, first_name')
          .eq('stripe_customer_id', customerId)
          .single();

        if (profile) {
          // TODO: envoyer un email de relance via Resend/SendGrid
          console.warn(`❌ Paiement échoué pour ${profile.email}`);
        }
        break;
      }

      // ── Essai gratuit terminé ──────────────────────────────────────────────
      case 'customer.subscription.trial_will_end': {
        const userId = obj.metadata?.supabase_user_id;
        if (userId) {
          // TODO: envoyer email "Votre essai se termine dans 3 jours"
          console.log(`ℹ Essai se termine bientôt pour user ${userId}`);
        }
        break;
      }

      default:
        // Événement non géré, ignorer
        break;
    }
  } catch (err) {
    console.error(`Erreur traitement webhook ${event.type}:`, err);
    // On répond 200 quand même pour éviter que Stripe re-tente indéfiniment
  }

  res.json({ received: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// DÉMARRAGE DU SERVEUR
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✦ PULSE API démarrée sur http://localhost:${PORT}`);
});

module.exports = app; // requis pour Vercel
