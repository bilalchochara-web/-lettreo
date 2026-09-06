/**
 * GET|POST /api/session-status
 *
 * Deux usages :
 *   1. Retour de Stripe Checkout — `session_id=cs_…` : le serveur vérifie
 *      auprès de Stripe que la session est bien payée, puis délivre un jeton
 *      d'accès signé que le navigateur conservera.
 *   2. Revalidation — `token=…` : le serveur recontrôle qu'un pass journée ou
 *      un abonnement est toujours valable.
 *
 * Le jeton n'est délivré QU'APRÈS confirmation du paiement par Stripe. Il ne
 * dispense d'aucun contrôle : /api/generate revérifie systématiquement le droit.
 *
 * Variables d'environnement : voir api/create-checkout-session.js.
 */

import { verifyCheckoutSession, verifyAccessToken, issueAccessToken } from './_lib/access.js';

const REASON_MESSAGES = {
  session_invalid: 'Paiement introuvable.',
  plan_unknown: 'Formule introuvable.',
  unpaid: 'Le paiement n’a pas été confirmé.',
  pass_expired: 'Votre pass journée a expiré.',
  subscription_inactive: 'Votre abonnement n’est plus actif.',
  already_used: 'Ce paiement a déjà servi à générer un courrier.',
  token_invalid: 'Accès expiré ou invalide.',
};

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const source = { ...(req.query || {}), ...(body || {}) };

  const sessionId = typeof source.session_id === 'string' ? source.session_id : '';
  const token = typeof source.token === 'string' ? source.token : '';

  let resolvedSessionId = sessionId;

  if (!resolvedSessionId && token) {
    const payload = verifyAccessToken(token);
    if (!payload) {
      return res.status(200).json({ ok: false, reason: 'token_invalid', message: REASON_MESSAGES.token_invalid });
    }
    resolvedSessionId = payload.sid;
  }

  if (!resolvedSessionId) {
    return res.status(400).json({ error: 'Paramètre session_id ou token requis.' });
  }

  try {
    const result = await verifyCheckoutSession(resolvedSessionId);

    if (!result.ok) {
      return res.status(200).json({
        ok: false,
        reason: result.reason,
        message: REASON_MESSAGES[result.reason] || 'Accès non valide.',
      });
    }

    const expiresAt = result.expiresAt || Date.now() + 24 * 60 * 60 * 1000;
    const accessToken = issueAccessToken({
      sessionId: result.sessionId,
      planId: result.plan.id,
      expiresAt,
    });

    return res.status(200).json({
      ok: true,
      plan: result.plan.id,
      plan_label: result.plan.label,
      unlimited: result.plan.letters === null,
      expires_at: expiresAt,
      access_token: accessToken,
    });
  } catch (err) {
    console.error('Vérification de session impossible:', err && err.message);
    return res.status(500).json({ error: 'Vérification du paiement momentanément indisponible.' });
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}
