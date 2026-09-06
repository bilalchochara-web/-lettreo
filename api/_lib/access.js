/**
 * Contrôle d'accès payant — TOUT SE JOUE ICI, CÔTÉ SERVEUR.
 *
 * Principe : le navigateur ne détient qu'un jeton signé opaque. Il ne peut ni
 * le fabriquer, ni en prolonger la validité, ni s'attribuer une formule.
 * À chaque génération de courrier, le droit est REVÉRIFIÉ en direct auprès de
 * Stripe (session payée ? abonnement toujours actif ? crédit déjà consommé ?).
 *
 * Le jeton n'est donc jamais une preuve de paiement à lui seul : il ne sert
 * qu'à désigner la session Stripe à contrôler, sans laisser un tiers énumérer
 * des identifiants de session sur notre endpoint.
 */

import crypto from 'node:crypto';
import { getStripe } from './stripe.js';
import { getPlan } from './plans.js';

const TOKEN_VERSION = 'v1';
const TOKEN_MAX_LENGTH = 2048;

/* -------------------------------------------------------------------------- */
/* Signature des jetons                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Clé de signature HMAC.
 * Utilise LETTREO_TOKEN_SECRET si elle est définie, sinon dérive une clé
 * dédiée à partir de STRIPE_SECRET_KEY (jamais la clé elle-même).
 */
function signingKey() {
  const explicit = process.env.LETTREO_TOKEN_SECRET;
  if (explicit && explicit.length >= 16) {
    return crypto.createHash('sha256').update('lettreo/token/' + explicit).digest();
  }
  const fallback = process.env.STRIPE_SECRET_KEY;
  if (!fallback) {
    throw new Error('Configuration serveur incomplète : aucun secret de signature disponible.');
  }
  return crypto.createHmac('sha256', fallback).update('lettreo/access-token/v1').digest();
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadPart) {
  return crypto
    .createHmac('sha256', signingKey())
    .update(TOKEN_VERSION + '.' + payloadPart)
    .digest('base64url');
}

/**
 * Fabrique un jeton d'accès signé.
 * @param {{sessionId: string, planId: string, expiresAt: number}} params
 */
export function issueAccessToken({ sessionId, planId, expiresAt }) {
  const payload = {
    sid: sessionId,
    plan: planId,
    iat: Date.now(),
    exp: expiresAt,
  };
  const payloadPart = b64url(JSON.stringify(payload));
  return TOKEN_VERSION + '.' + payloadPart + '.' + sign(payloadPart);
}

/**
 * Vérifie la signature et l'expiration d'un jeton.
 * @returns {{sid: string, plan: string, iat: number, exp: number}|null}
 */
export function verifyAccessToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0 || rawToken.length > TOKEN_MAX_LENGTH) {
    return null;
  }
  const parts = rawToken.split('.');
  if (parts.length !== 3) return null;

  const version = parts[0];
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (version !== TOKEN_VERSION) return null;

  let expected;
  try {
    expected = sign(payloadPart);
  } catch (err) {
    return null;
  }

  const given = Buffer.from(signaturePart, 'base64url');
  const wanted = Buffer.from(expected, 'base64url');
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }

  if (!payload || typeof payload.sid !== 'string' || typeof payload.exp !== 'number') return null;
  if (Date.now() > payload.exp) return null;

  return payload;
}

/* -------------------------------------------------------------------------- */
/* Vérification du droit réel auprès de Stripe                                 */
/* -------------------------------------------------------------------------- */

function subscriptionPeriodEnd(subscription) {
  if (typeof subscription.current_period_end === 'number') {
    return subscription.current_period_end * 1000;
  }
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  if (item && typeof item.current_period_end === 'number') {
    return item.current_period_end * 1000;
  }
  return null;
}

/**
 * Contrôle en direct auprès de Stripe qu'une session de paiement ouvre bien
 * un droit à générer un courrier.
 *
 * @param {string} sessionId identifiant de session Stripe Checkout
 * @returns {Promise<object>} { ok, reason?, plan?, sessionId?, paymentIntentId?,
 *   subscriptionId?, expiresAt? }
 */
export async function verifyCheckoutSession(sessionId) {
  if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return { ok: false, reason: 'session_invalid' };
  }

  const stripe = getStripe();

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (err && err.statusCode === 404) return { ok: false, reason: 'session_invalid' };
    throw err;
  }

  // La formule est lue dans les métadonnées posées par le serveur au moment de
  // la création de la session — jamais dans ce que transmet le client.
  const plan = getPlan(session.metadata && session.metadata.lettreo_plan);
  if (!plan) return { ok: false, reason: 'plan_unknown' };

  if (plan.mode === 'subscription') {
    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : (session.subscription && session.subscription.id);
    if (!subscriptionId) return { ok: false, reason: 'unpaid' };

    let subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      if (err && err.statusCode === 404) return { ok: false, reason: 'subscription_inactive' };
      throw err;
    }

    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      return { ok: false, reason: 'subscription_inactive' };
    }

    return {
      ok: true,
      plan,
      sessionId: session.id,
      subscriptionId,
      paymentIntentId: null,
      expiresAt: subscriptionPeriodEnd(subscription),
    };
  }

  // Formules réglées en une fois (unité et pass journée).
  if (session.payment_status !== 'paid') {
    return { ok: false, reason: 'unpaid' };
  }

  if (plan.id === 'day') {
    const expiresAt = session.created * 1000 + plan.durationMs;
    if (Date.now() > expiresAt) return { ok: false, reason: 'pass_expired' };
    return {
      ok: true,
      plan,
      sessionId: session.id,
      paymentIntentId: null,
      subscriptionId: null,
      expiresAt,
    };
  }

  // Formule à l'unité : un seul courrier. La consommation est tracée sur le
  // PaymentIntent — Stripe fait office de registre, sans base de données.
  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : (session.payment_intent && session.payment_intent.id);
  if (!paymentIntentId) return { ok: false, reason: 'unpaid' };

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.status !== 'succeeded') return { ok: false, reason: 'unpaid' };
  if (paymentIntent.metadata && paymentIntent.metadata.lettreo_consumed_at) {
    return { ok: false, reason: 'already_used' };
  }

  return {
    ok: true,
    plan,
    sessionId: session.id,
    paymentIntentId,
    subscriptionId: null,
    // Le crédit reste valable tant qu'il n'est pas consommé ; on borne malgré
    // tout la durée de vie du jeton pour limiter sa réutilisation.
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
}

/**
 * Vérifie un jeton d'accès, puis le droit réel derrière lui.
 * @param {string} rawToken
 */
export async function verifyEntitlement(rawToken) {
  const payload = verifyAccessToken(rawToken);
  if (!payload) return { ok: false, reason: 'token_invalid' };
  return verifyCheckoutSession(payload.sid);
}

/* -------------------------------------------------------------------------- */
/* Consommation du crédit à l'unité                                            */
/* -------------------------------------------------------------------------- */

/**
 * Marque le crédit « à l'unité » comme consommé AVANT la génération, pour
 * qu'un même paiement ne puisse pas produire deux courriers.
 * @returns {Promise<boolean>} false si le crédit était déjà consommé.
 */
export async function reserveUnitCredit(paymentIntentId) {
  const stripe = getStripe();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (paymentIntent.metadata && paymentIntent.metadata.lettreo_consumed_at) return false;

  await stripe.paymentIntents.update(paymentIntentId, {
    metadata: { lettreo_consumed_at: new Date().toISOString() },
  });
  return true;
}

/**
 * Libère le crédit si la génération a échoué : l'utilisateur ne doit pas
 * perdre son courrier à cause d'une erreur de notre côté.
 */
export async function releaseUnitCredit(paymentIntentId) {
  try {
    const stripe = getStripe();
    // Une valeur vide supprime la clé de métadonnée côté Stripe.
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: { lettreo_consumed_at: '' },
    });
  } catch (err) {
    console.error('Libération du crédit impossible', paymentIntentId, err && err.message);
  }
}
