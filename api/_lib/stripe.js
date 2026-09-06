/**
 * Client Stripe partagé.
 *
 * La clé secrète provient EXCLUSIVEMENT de process.env.STRIPE_SECRET_KEY.
 * Aucune clé n'est écrite en dur dans le code source.
 */

import Stripe from 'stripe';

let cachedClient = null;
let cachedKey = null;

/**
 * Renvoie le client Stripe.
 * @throws {Error} si STRIPE_SECRET_KEY est absente (échec fermé).
 */
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('Configuration serveur incomplète : STRIPE_SECRET_KEY manquante.');
  }
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new Stripe(key, { maxNetworkRetries: 2 });
    cachedKey = key;
  }
  return cachedClient;
}
