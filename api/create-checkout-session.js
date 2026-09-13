/**
 * POST /api/create-checkout-session
 *
 * Crée une session Stripe Checkout pour l'une des trois formules Lettreo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VARIABLES D'ENVIRONNEMENT REQUISES (à définir dans Vercel → Settings →
 * Environment Variables, JAMAIS dans le code source ni dans le dépôt Git) :
 *
 *   STRIPE_SECRET_KEY       Clé secrète Stripe (sk_live_… en production,
 *                           sk_test_… en test). Utilisée uniquement côté serveur.
 *
 *   STRIPE_WEBHOOK_SECRET   Secret de signature du webhook (whsec_…), fourni par
 *                           Stripe lors de la création du endpoint webhook.
 *                           Utilisé par /api/webhook.js pour vérifier que les
 *                           notifications proviennent bien de Stripe.
 *
 *   STRIPE_PRICE_ID_UNITE    ID du tarif « à l'unité »        → 1,90 € TTC (paiement unique)
 *   STRIPE_PRICE_ID_JOURNEE  ID du tarif « pass journée »     → 2,90 € TTC (paiement unique)
 *   STRIPE_PRICE_ID_MENSUEL  ID du tarif « abonnement mois »  → 4,90 € TTC/mois (récurrent)
 *   (Les anciens noms STRIPE_PRICE_ID_UNIT, _DAY et _MONTH restent acceptés.)
 *
 * VARIABLES OPTIONNELLES :
 *
 *   PUBLIC_BASE_URL         URL publique du site (ex. https://lettreo.fr).
 *                           Recommandée : elle sécurise les URL de retour après
 *                           paiement. À défaut, l'en-tête Host de la requête est
 *                           utilisé.
 *
 *   LETTREO_TOKEN_SECRET    Secret dédié à la signature des jetons d'accès.
 *                           À défaut, une clé est dérivée de STRIPE_SECRET_KEY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SÉCURITÉ — le corps de la requête ne contient QUE l'identifiant de formule
 * ("unit" | "day" | "month"). Le montant facturé n'est jamais transmis par le
 * navigateur : il est déterminé côté serveur dans api/_lib/plans.js, et le tarif
 * Stripe configuré est recontrôlé avant toute création de session.
 */

import { getStripe } from './_lib/stripe.js';
import { getPlan, getPriceId } from './_lib/plans.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Reconstruit l'URL publique du site pour les redirections de retour. */
function baseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) throw new Error('Impossible de déterminer l’URL du site.');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

/**
 * Détermine la ligne de facturation.
 * - Si le tarif Stripe est configuré : on l'utilise, APRÈS avoir vérifié qu'il
 *   correspond bien au montant attendu (garde-fou contre une mauvaise config).
 * - Sinon : on construit le tarif à la volée depuis la constante serveur.
 */
async function buildLineItem(stripe, plan) {
  const configured = getPriceId(plan);

  if (configured) {
    const price = await stripe.prices.retrieve(configured.id);

    if (price.unit_amount !== plan.amount || price.currency !== plan.currency) {
      throw new Error(
        `Tarif Stripe incohérent pour la formule "${plan.id}" : ` +
        `${price.unit_amount} ${price.currency} configuré, ` +
        `${plan.amount} ${plan.currency} attendu (${configured.name}).`
      );
    }
    const isRecurring = Boolean(price.recurring);
    if (isRecurring !== (plan.mode === 'subscription')) {
      throw new Error(`Type de tarif Stripe incohérent pour la formule "${plan.id}" (${configured.name}).`);
    }

    return { price: configured.id, quantity: 1 };
  }

  // Repli : montant fixé par le serveur, sans tarif préenregistré.
  const priceData = {
    currency: plan.currency,
    unit_amount: plan.amount,
    product_data: { name: `Lettreo — ${plan.label}`, description: plan.description },
  };
  if (plan.mode === 'subscription') {
    priceData.recurring = { interval: plan.interval };
  }
  return { price_data: priceData, quantity: 1 };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const planId = body && body.plan;

  const plan = getPlan(planId);
  if (!plan) {
    return res.status(400).json({ error: 'Formule inconnue.' });
  }

  // Email facultatif, uniquement pour préremplir Checkout.
  const rawEmail = body && typeof body.email === 'string' ? body.email.trim() : '';
  const customerEmail = EMAIL_RE.test(rawEmail) && rawEmail.length <= 254 ? rawEmail : undefined;

  try {
    const stripe = getStripe();
    const site = baseUrl(req);
    const lineItem = await buildLineItem(stripe, plan);

    const session = await stripe.checkout.sessions.create({
      mode: plan.mode,
      line_items: [lineItem],
      locale: 'auto',
      customer_email: customerEmail,
      // La formule est inscrite dans les métadonnées : c'est elle qui fera foi
      // lors de la vérification du droit, côté serveur.
      metadata: { lettreo_plan: plan.id },
      ...(plan.mode === 'subscription'
        ? { subscription_data: { metadata: { lettreo_plan: plan.id } } }
        : { payment_intent_data: { metadata: { lettreo_plan: plan.id } } }),
      success_url: `${site}/?checkout=success&session_id={CHECKOUT_SESSION_ID}#assistant`,
      cancel_url: `${site}/?checkout=cancel#assistant`,
    });

    return res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Création de session Checkout impossible:', err && err.message);
    return res.status(500).json({ error: 'Le paiement est momentanément indisponible.' });
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}
