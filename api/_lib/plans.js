/**
 * Catalogue des formules Lettreo — SOURCE DE VÉRITÉ CÔTÉ SERVEUR.
 *
 * Le frontend n'envoie JAMAIS de prix : il envoie uniquement un identifiant
 * de formule ("unit" | "day" | "month"). Le montant facturé est déterminé ici.
 *
 * Les montants sont exprimés en centimes d'euro.
 */

export const PLANS = {
  unit: {
    id: 'unit',
    mode: 'payment',
    amount: 190,               // 1,90 €
    currency: 'eur',
    priceEnv: ['STRIPE_PRICE_ID_UNITE', 'STRIPE_PRICE_ID_UNIT'],
    label: 'Courrier à l\u2019unité',
    description: 'Un courrier généré, relu et téléchargeable en PDF.',
    // Une seule génération : la consommation est tracée côté Stripe.
    letters: 1,
    durationMs: null,
  },
  day: {
    id: 'day',
    mode: 'payment',
    amount: 290,               // 2,90 €
    currency: 'eur',
    priceEnv: ['STRIPE_PRICE_ID_JOURNEE', 'STRIPE_PRICE_ID_DAY'],
    label: 'Pass journée',
    description: 'Courriers illimités pendant 24 heures.',
    letters: null,
    durationMs: 24 * 60 * 60 * 1000,
  },
  month: {
    id: 'month',
    mode: 'subscription',
    amount: 490,               // 4,90 €
    currency: 'eur',
    priceEnv: ['STRIPE_PRICE_ID_MENSUEL', 'STRIPE_PRICE_ID_MONTH'],
    label: 'Abonnement mensuel',
    description: 'Courriers illimités, résiliable à tout moment.',
    letters: null,
    durationMs: null,
    interval: 'month',
  },
};

/**
 * Renvoie l'ID de tarif Stripe configuré pour la formule, avec le nom de la
 * variable d'environnement qui le porte, ou null si aucune n'est définie.
 * Le premier nom de `priceEnv` est celui utilisé dans Vercel ; le second, plus
 * ancien, reste accepté.
 */
export function getPriceId(plan) {
  for (const name of plan.priceEnv) {
    if (process.env[name]) return { name, id: process.env[name] };
  }
  return null;
}

/** Renvoie la formule correspondant à l'identifiant, ou null si inconnu. */
export function getPlan(planId) {
  if (typeof planId !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(PLANS, planId) ? PLANS[planId] : null;
}
