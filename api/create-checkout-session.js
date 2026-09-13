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
 *
 * Un code promo facultatif peut accompagner la formule. Il n'est jamais transmis
 * tel quel : il est d'abord résolu auprès de Stripe (code promotionnel actif ou
 * coupon valide). La réduction appliquée est donc toujours celle définie dans
 * Stripe, jamais un montant venu du navigateur.
 */

import { getStripe } from './_lib/stripe.js';
import { getPlan, getPriceId } from './_lib/plans.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PROMO_RE = /^[A-Za-z0-9_-]{2,64}$/;
const PROMO_INVALID = { error: 'Ce code promo n’est pas valide ou a expiré.', reason: 'promo_invalid' };

/**
 * Résout le code saisi en réduction Stripe, ou renvoie null s'il n'est pas
 * utilisable. Accepte un code promotionnel Stripe, puis un identifiant de
 * coupon (ex. « BETA100 » créé avec cet identifiant). La casse saisie est
 * tolérée : « beta100 » retrouve « BETA100 ».
 */
async function resolveDiscount(stripe, input) {
  const candidates = [...new Set([input, input.toUpperCase()])];

  for (const code of candidates) {
    const { data } = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    const promo = data[0];
    if (!promo) continue;

    const expired = promo.expires_at && promo.expires_at * 1000 <= Date.now();
    const exhausted = promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions;
    const coupon = promo.coupon || (promo.promotion && promo.promotion.coupon);
    const couponInvalid = coupon && typeof coupon === 'object' && coupon.valid === false;
    return expired || exhausted || couponInvalid ? null : { promotion_code: promo.id };
  }

  for (const code of candidates) {
    try {
      const coupon = await stripe.coupons.retrieve(code);
      return coupon && !coupon.deleted && coupon.valid ? { coupon: coupon.id } : null;
    } catch (err) {
      if (!err || err.statusCode !== 404) throw err;
    }
  }
  return null;
}

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

  // Code promo facultatif.
  const promoCode = body && typeof body.promo_code === 'string' ? body.promo_code.trim() : '';
  if (promoCode && !PROMO_RE.test(promoCode)) {
    return res.status(400).json(PROMO_INVALID);
  }

  try {
    const stripe = getStripe();
    const site = baseUrl(req);
    const lineItem = await buildLineItem(stripe, plan);

    const discount = promoCode ? await resolveDiscount(stripe, promoCode) : null;
    if (promoCode && !discount) {
      return res.status(400).json(PROMO_INVALID);
    }

    const session = await stripe.checkout.sessions.create({
      mode: plan.mode,
      line_items: [lineItem],
      locale: 'auto',
      customer_email: customerEmail,
      ...(discount ? { discounts: [discount] } : {}),
      // Une session rendue gratuite par le code n'a pas de PaymentIntent : le
      // client Stripe créé ici sert alors de registre au crédit à l'unité.
      ...(discount && plan.mode === 'payment' ? { customer_creation: 'always' } : {}),
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
    // Code reconnu mais refusé par Stripe à la création (épuisé entre-temps,
    // réservé à d'autres produits…) : c'est le code qui est en cause.
    const promoError = err && (String(err.param || '').startsWith('discounts')
      || /coupon|promotion/i.test(String(err.code || '')));
    if (promoCode && promoError) {
      return res.status(400).json(PROMO_INVALID);
    }
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
