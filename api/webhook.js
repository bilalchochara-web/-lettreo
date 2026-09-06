/**
 * POST /api/webhook — notifications Stripe.
 *
 * Variables d'environnement utilisées :
 *   STRIPE_SECRET_KEY      (client Stripe)
 *   STRIPE_WEBHOOK_SECRET  (secret de signature du endpoint, whsec_…)
 *   Voir la documentation complète en tête de api/create-checkout-session.js.
 *
 * SÉCURITÉ — la signature de CHAQUE requête est vérifiée avec le corps BRUT et
 * l'en-tête `stripe-signature`. Toute requête dont la signature ne correspond
 * pas est rejetée en 400, sans être traitée. Aucune donnée transmise dans le
 * corps n'est prise en compte avant cette vérification.
 *
 * À configurer dans Stripe → Developers → Webhooks :
 *   URL      : https://<votre-domaine>/api/webhook
 *   Événements : checkout.session.completed, invoice.payment_succeeded
 */

import { getStripe } from './_lib/stripe.js';
import { getPlan } from './_lib/plans.js';

// Le corps doit rester brut : toute réécriture invaliderait la signature.
export const config = {
  api: { bodyParser: false },
};

/**
 * Récupère le corps brut de la requête, sans jamais le reconstruire à partir
 * d'un objet déjà analysé si une source fidèle est disponible.
 */
async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');

  if (req.readable) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // Dernier recours : le corps a déjà été analysé par la plateforme. La
  // signature reste vérifiée ensuite — en cas d'écart, la requête est rejetée.
  if (req.body && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  return null;
}

/** checkout.session.completed — le paiement initial est allé au bout. */
async function onCheckoutCompleted(stripe, session) {
  const plan = getPlan(session.metadata && session.metadata.lettreo_plan);
  if (!plan) {
    console.warn('Session Checkout sans formule Lettreo identifiable:', session.id);
    return;
  }

  console.log(
    `Paiement confirmé — formule "${plan.id}" (${plan.amount / 100} €), session ${session.id}, ` +
    `statut ${session.payment_status}`
  );

  // On recopie la formule sur l'objet de paiement : c'est ce qui permet, plus
  // tard, de retrouver le droit ouvert sans base de données.
  try {
    if (plan.mode === 'subscription') {
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription && session.subscription.id);
      if (subscriptionId) {
        await stripe.subscriptions.update(subscriptionId, {
          metadata: { lettreo_plan: plan.id, lettreo_session: session.id },
        });
      }
    } else {
      const paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent && session.payment_intent.id);
      if (paymentIntentId) {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        // Idempotence : ne jamais écraser un crédit déjà consommé.
        if (!(paymentIntent.metadata && paymentIntent.metadata.lettreo_consumed_at)) {
          await stripe.paymentIntents.update(paymentIntentId, {
            metadata: { lettreo_plan: plan.id, lettreo_session: session.id },
          });
        }
      }
    }
  } catch (err) {
    console.error('Annotation du paiement impossible:', session.id, err && err.message);
  }
}

/** invoice.payment_succeeded — échéance mensuelle réglée (ou 1re facture). */
function onInvoicePaid(invoice) {
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : (invoice.subscription && invoice.subscription.id);

  console.log(
    `Facture réglée — ${(invoice.amount_paid || 0) / 100} ${String(invoice.currency || '').toUpperCase()}, ` +
    `abonnement ${subscriptionId || 'n/a'}, facture ${invoice.id}`
  );

  // Aucune écriture nécessaire : l'accès mensuel est revalidé en direct auprès
  // de Stripe à chaque génération (voir api/_lib/access.js). Une échéance
  // impayée rend donc l'abonnement inactif, et le blocage est immédiat.
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET absente : webhook refusé.');
    return res.status(500).json({ error: 'Webhook non configuré.' });
  }
  if (!signature) {
    return res.status(400).json({ error: 'Signature Stripe absente.' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('Lecture du corps brut impossible:', err && err.message);
    return res.status(400).json({ error: 'Corps de requête illisible.' });
  }
  if (!rawBody) {
    return res.status(400).json({ error: 'Corps de requête illisible.' });
  }

  const stripe = getStripe();

  // ── Vérification de signature : rien n'est traité avant ce point. ──────────
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.warn('Signature Stripe invalide, requête rejetée:', err && err.message);
    return res.status(400).json({ error: 'Signature invalide.' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutCompleted(stripe, event.data.object);
        break;

      case 'invoice.payment_succeeded':
        onInvoicePaid(event.data.object);
        break;

      default:
        // Événement non suivi : accusé de réception pour éviter les relances.
        break;
    }
  } catch (err) {
    console.error('Traitement du webhook en échec:', event.type, err && err.message);
    // 500 → Stripe réessaiera l'envoi.
    return res.status(500).json({ error: 'Traitement impossible.' });
  }

  return res.status(200).json({ received: true });
}
