/**
 * GET /api/payment-status
 *
 * Indique à l'interface si le paiement en ligne est ouvert, pour afficher
 * « Paiement bientôt disponible » au lieu d'un bouton qui échouerait.
 *
 * Le paiement est considéré ouvert dès que la clé Stripe ET la clé Claude sont
 * configurées : sans la seconde, un client pourrait payer sans recevoir son
 * courrier. Le message disparaît donc de lui-même au premier déploiement qui
 * suit la configuration de ces variables dans Vercel.
 *
 * SÉCURITÉ — la réponse est un simple booléen : elle ne révèle ni quelle
 * variable manque, ni aucune valeur de configuration.
 */

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const paymentsEnabled = Boolean(process.env.STRIPE_SECRET_KEY && process.env.ANTHROPIC_API_KEY);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ payments_enabled: paymentsEnabled });
}
