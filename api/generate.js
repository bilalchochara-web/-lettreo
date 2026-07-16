const DISPOSABLE_EMAIL_DOMAINS = [
  'yopmail.com', 'mailinator.com', 'guerrillamail.com', 'tempmail.com',
  '10minutemail.com', 'throwam.com', 'sharklasers.com', 'trashmail.com'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    type_courrier, situation, ton_souhaite,
    destinataire_nom, destinataire_adresse, destinataire_cp, destinataire_ville, demande_finale,
    expediteur_nom, expediteur_email, expediteur_adresse, expediteur_cp, expediteur_ville, expediteur_telephone
  } = req.body;

  const emailDomain = (expediteur_email || '').split('@')[1]?.toLowerCase().trim();
  if (emailDomain && DISPOSABLE_EMAIL_DOMAINS.includes(emailDomain)) {
    return res.status(400).json({ error: 'Veuillez utiliser une adresse email valide.' });
  }

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
9. Ne mets AUCUNE mention, avertissement ou note après la signature. Le courrier se termine après la signature et les éventuelles pièces jointes. Rien d'autre.`;

  const userContent = `Génère le courrier correspondant à cette situation. Si la situation est décrite dans une autre langue que le français, comprends-la mais génère le courrier entièrement en français.

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
      const error = await response.json();
      return res.status(response.status).json({ error: error.error?.message || 'Erreur API Claude' });
    }

    const data = await response.json();
    const letter = data.content?.[0]?.text || '';

    if (!letter) {
      return res.status(500).json({ error: 'Réponse vide de Claude' });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ letter });

  } catch (err) {
    console.error('Erreur génération courrier:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
