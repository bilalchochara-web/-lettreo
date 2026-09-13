/**
 * POST /api/generate — génération du courrier.
 *
 * SÉCURITÉ — aucune génération n'est possible sans droit de paiement valide.
 * Le contrôle est fait ICI, côté serveur : masquer le bouton dans l'interface
 * ne protège rien. À chaque appel, le jeton d'accès est vérifié (signature +
 * expiration) puis le droit réel est recontrôlé en direct auprès de Stripe
 * (session payée, abonnement actif, crédit à l'unité non encore consommé).
 *
 * Variables d'environnement :
 *   ANTHROPIC_API_KEY   Clé API Claude.
 *   STRIPE_SECRET_KEY   Voir la documentation en tête de api/create-checkout-session.js.
 */

import { verifyEntitlement, reserveUnitCredit, releaseUnitCredit } from './_lib/access.js';

const DISPOSABLE_EMAIL_DOMAINS = [
  'yopmail.com', 'mailinator.com', 'guerrillamail.com', 'tempmail.com',
  '10minutemail.com', 'throwam.com', 'sharklasers.com', 'trashmail.com'
];

// Langues proposées par l'interface. Le courrier sort toujours en français.
const INPUT_LANGUAGES = {
  fr: 'français', ar: 'arabe', en: 'anglais', es: 'espagnol',
  tr: 'turc', ru: 'russe', zh: 'chinois simplifié',
};

const PAYMENT_ERRORS = {
  token_invalid: 'Votre accès a expiré. Choisissez une formule pour continuer.',
  session_invalid: 'Paiement introuvable. Choisissez une formule pour continuer.',
  plan_unknown: 'Paiement introuvable. Choisissez une formule pour continuer.',
  unpaid: 'Le paiement n’a pas été confirmé.',
  pass_expired: 'Votre pass journée a expiré.',
  subscription_inactive: 'Votre abonnement n’est plus actif.',
  already_used: 'Ce paiement a déjà servi à générer un courrier.',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Requête invalide.' });
  }

  /* ---------------------------------------------------------------------- */
  /* 1. Contrôle du paiement — avant toute autre chose                       */
  /* ---------------------------------------------------------------------- */

  const accessToken = req.headers['x-lettreo-access-token'] || body.access_token;

  let entitlement;
  try {
    entitlement = await verifyEntitlement(accessToken);
  } catch (err) {
    console.error('Vérification du droit d’accès impossible:', err && err.message);
    return res.status(503).json({ error: 'Vérification du paiement momentanément indisponible.' });
  }

  if (!entitlement.ok) {
    return res.status(402).json({
      error: PAYMENT_ERRORS[entitlement.reason] || 'Un paiement est requis pour générer ce courrier.',
      payment_required: true,
      reason: entitlement.reason,
    });
  }

  const {
    type_courrier, situation, ton_souhaite,
    destinataire_nom, destinataire_adresse, destinataire_cp, destinataire_ville, demande_finale,
    expediteur_nom, expediteur_email, expediteur_adresse, expediteur_cp, expediteur_ville, expediteur_telephone,
    langue_interface
  } = body;

  const emailDomain = (expediteur_email || '').split('@')[1]?.toLowerCase().trim();
  if (emailDomain && DISPOSABLE_EMAIL_DOMAINS.includes(emailDomain)) {
    return res.status(400).json({ error: 'Veuillez utiliser une adresse email valide.' });
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Consommation du crédit « à l'unité »                                 */
  /* ---------------------------------------------------------------------- */

  // Le crédit est réservé AVANT la génération pour qu'un même paiement ne
  // puisse pas produire deux courriers ; il est rendu si la génération échoue.
  let reservedLedger = null;
  if (entitlement.plan.id === 'unit' && entitlement.ledger) {
    try {
      const reserved = await reserveUnitCredit(entitlement.ledger);
      if (!reserved) {
        return res.status(402).json({
          error: PAYMENT_ERRORS.already_used,
          payment_required: true,
          reason: 'already_used',
        });
      }
      reservedLedger = entitlement.ledger;
    } catch (err) {
      console.error('Réservation du crédit impossible:', err && err.message);
      return res.status(503).json({ error: 'Vérification du paiement momentanément indisponible.' });
    }
  }

  const releaseCredit = async () => {
    if (reservedLedger) {
      await releaseUnitCredit(reservedLedger);
      reservedLedger = null;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* 3. Génération du courrier                                               */
  /* ---------------------------------------------------------------------- */

  const destAdresseParts = [destinataire_adresse, [destinataire_cp, destinataire_ville].filter(Boolean).join(' ')].filter(Boolean);
  const destAdresseLine = destAdresseParts.length ? destAdresseParts.join(', ') : '[À COMPLÉTER : adresse du destinataire]';

  const expAdresseParts = [expediteur_adresse, [expediteur_cp, expediteur_ville].filter(Boolean).join(' ')].filter(Boolean);
  const expAdresseLine = expAdresseParts.length ? expAdresseParts.join(', ') : '[À COMPLÉTER : adresse de l\'expéditeur]';

  const systemPrompt = `Tu es un expert en rédaction de courriers administratifs et professionnels français. Tu rédiges des courriers formels, clairs et juridiquement corrects pour des particuliers qui ne maîtrisent pas les codes de la correspondance officielle.

RÈGLES ABSOLUES :
1. Tu rédiges UNIQUEMENT le courrier — rien d'autre avant ou après.
2. Structure obligatoire selon les normes françaises :
   - En haut à GAUCHE : coordonnées complètes de l'expéditeur (nom, adresse, email, téléphone)
   - En haut à DROITE : coordonnées du destinataire (nom/organisme, adresse) — indique DROITE dans le texte avec des tabulations ou espaces pour simuler l'alignement à droite
   - Dessous : ville et date (ex : Toulouse, le 9 juillet 2026)
   - Objet : (souligné)
   - Formule d'appel
   - Corps en 3 paragraphes (contexte / demande précise / action+délai)
   - Formule de politesse complète
   - Signature
3. Cite TOUJOURS l'article de loi applicable à la situation si tu en connais un (ex: article 22 loi du 6 juillet 1989 pour les dépôts de garantie, article L1237-19 Code du travail pour la rupture conventionnelle, etc.). Si tu ne connais pas l'article exact, n'en invente pas.
4. Tu adaptes le ton selon le type de courrier demandé (ferme / neutre / conciliant).
5. Tu n'inventes JAMAIS de faits, dates, références ou montants non fournis. Utilise [À COMPLÉTER : description] si une info manque.
6. Vouvoiement systématique. Jamais de tutoiement.
7. Le corps du courrier ne contient aucun conseil juridique ni mise en garde.
8. Texte brut uniquement. Pas de markdown. Paragraphes séparés par une ligne vide.
9. Ne mets AUCUNE mention, avertissement ou note après la signature. Le courrier se termine après la signature et les éventuelles pièces jointes. Rien d'autre.
10. L'utilisateur peut décrire sa situation en français, arabe, anglais, espagnol, turc, russe ou chinois. Quelle que soit cette langue, tu comprends le récit tel qu'il est exprimé et tu rédiges le courrier EXCLUSIVEMENT en français administratif : aucun mot, aucune citation, aucun caractère de la langue d'origine ne doit y figurer. Tu ne traduis pas mot à mot : tu restitues fidèlement les faits avec les formulations d'usage d'un courrier français. Montants et dates suivent les conventions françaises (ex. : 800 €, 3 mars 2026).
11. Les noms propres et adresses écrits dans un alphabet non latin (arabe, cyrillique, caractères chinois) sont transcrits en caractères latins selon la translittération usuelle (pinyin pour le chinois). Ceux déjà écrits en caractères latins sont repris à l'identique.`;

  // Langue de l'interface, transmise comme simple indice : seules les valeurs
  // connues sont reprises, jamais un texte libre venu du navigateur.
  const languageLine = langue_interface !== 'fr'
    && Object.prototype.hasOwnProperty.call(INPUT_LANGUAGES, langue_interface)
    ? `\nLANGUE PROBABLE DE LA SITUATION : ${INPUT_LANGUAGES[langue_interface]}. Le courrier reste intégralement en français.\n`
    : '';

  const userContent = `Génère le courrier correspondant à cette situation. Si la situation est décrite dans une autre langue que le français, comprends-la mais génère le courrier entièrement en français.
${languageLine}
TYPE DE COURRIER : ${type_courrier}

SITUATION DÉCRITE :
${situation}

DESTINATAIRE :
- Nom / organisme : ${destinataire_nom || '[À COMPLÉTER : nom du destinataire]'}
- Adresse : ${destAdresseLine}

EXPÉDITEUR :
- Prénom Nom : ${expediteur_nom}
- Email : ${expediteur_email}
- Adresse : ${expAdresseLine}
- Téléphone : ${expediteur_telephone || ''}

TON SOUHAITÉ : ${ton_souhaite}

DEMANDE FINALE ATTENDUE DU DESTINATAIRE :
${demande_finale || 'Résoudre la situation décrite ci-dessus'}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!response.ok) {
      await releaseCredit();
      const error = await response.json();
      return res.status(response.status).json({ error: error.error?.message || 'Erreur API Claude' });
    }

    const data = await response.json();
    const letter = data.content?.[0]?.text || '';

    if (!letter) {
      await releaseCredit();
      return res.status(500).json({ error: 'Réponse vide de Claude' });
    }

    // Restreint au domaine public : l'interface appelle /api/generate en URL
    // relative (même origine), donc ce header ne sert qu'à empêcher un autre
    // site d'appeler cette API payante depuis le navigateur d'un visiteur.
    res.setHeader('Access-Control-Allow-Origin', 'https://lettreo.fr');
    res.setHeader('Vary', 'Origin');
    return res.status(200).json({
      letter,
      plan: entitlement.plan.id,
      credit_consumed: Boolean(reservedLedger),
    });

  } catch (err) {
    await releaseCredit();
    console.error('Erreur génération courrier:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}
