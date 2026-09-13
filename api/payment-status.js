/**
 * GET /api/payment-status
 *
 * Indique à l'interface si le paiement en ligne est réellement possible, pour
 * afficher « Paiement bientôt disponible » au lieu d'un bouton qui échouerait.
 *
 * Le paiement est considéré ouvert seulement si :
 *   - la clé Stripe ET la clé Claude sont configurées (sans la seconde, un
 *     client pourrait payer sans recevoir son courrier) ;
 *   - le compte Stripe est autorisé à encaisser (charges_enabled) ;
 *   - le tarif de chacune des trois formules est trouvé et cohérent.
 * Le message disparaît donc de lui-même dès que la configuration est correcte.
 *
 * Quand le paiement est fermé, la cause exacte est écrite dans les journaux
 * du serveur (Vercel → Logs), jamais dans la réponse.
 *
 * SÉCURITÉ — la réponse est un simple booléen : elle ne révèle ni la cause,
 * ni aucune valeur de configuration.
 */

import { getStripe } from './_lib/stripe.js';
import { PLANS, buildLineItem } from './_lib/plans.js';

// Résultat conservé une minute par instance, pour ne pas interroger Stripe à
// chaque visite.
const CACHE_MS = 60 * 1000;
let cache = { at: 0, result: null };

async function checkPayments() {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: 'STRIPE_SECRET_KEY ou ANTHROPIC_API_KEY absente' };
  }

  const stripe = getStripe();

  try {
    const account = await stripe.accounts.retrieve();
    if (account && account.charges_enabled === false) {
      return { ok: false, reason: 'compte Stripe pas encore autorisé à encaisser (charges_enabled = false)' };
    }
  } catch (err) {
    // Une clé restreinte peut ne pas lire le compte : on n'en conclut rien.
    console.warn('Statut du compte Stripe illisible, contrôle ignoré :', err && err.message);
  }

  for (const plan of Object.values(PLANS)) {
    try {
      await buildLineItem(stripe, plan);
    } catch (err) {
      return { ok: false, reason: err && err.message };
    }
  }

  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (!cache.result || Date.now() - cache.at > CACHE_MS) {
    let result;
    try {
      result = await checkPayments();
    } catch (err) {
      result = { ok: false, reason: 'vérification impossible : ' + (err && err.message) };
    }
    if (!result.ok) console.error('Paiement fermé —', result.reason);
    cache = { at: Date.now(), result };
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ payments_enabled: cache.result.ok });
}
