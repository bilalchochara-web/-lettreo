// /api/generate.js — Vercel Serverless Function
// Appelle directement l'API Anthropic pour générer le courrier (remplace le webhook Make).

const SYSTEM_PROMPT = `Tu es un expert en rédaction de courriers administratifs et professionnels français.
Tu rédiges des courriers formels, clairs et juridiquement corrects pour des particuliers
qui ne maîtrisent pas les codes de la correspondance officielle.

RÈGLES ABSOLUES :
1. Tu rédiges UNIQUEMENT le courrier — rien d'autre avant ou après.
2. Structure obligatoire : coordonnées expéditeur, ville+date, coordonnées destinataire,
   Objet, formule d'appel, corps en 3 paragraphes (contexte / demande précise /
   action+délai), formule de politesse, signature.
3. Tu adaptes le ton selon le type de courrier demandé.
4. Tu n'inventes JAMAIS de faits, dates, références ou montants non fournis.
   Utilise [À COMPLÉTER : description] si une info manque.
5. Vouvoiement systématique.
6. Le corps du courrier ne contient aucun conseil juridique ni mise en garde.
7. Texte brut, pas de markdown, paragraphes séparés par une ligne vide.
8. Après le courrier complet, ajoute sur une ligne séparée précédée d'une ligne vide :
---
⚠️ Ce texte est une aide à la rédaction et ne constitue pas un conseil juridique.
Pour les situations sensibles ou à forts enjeux, il est recommandé de faire relire
ce courrier par un professionnel du droit.
Cette mention n'est jamais dans le courrier envoyé au destinataire.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const {
    type_courrier, situation, ton_souhaite,
    destinataire_nom, destinataire_adresse, demande_finale,
    expediteur_nom, expediteur_email, expediteur_adresse, expediteur_telephone,
  } = req.body || {};

  if (!type_courrier || !situation || !expediteur_nom || !expediteur_email) {
    res.status(400).json({ error: 'Champs obligatoires manquants.' });
    return;
  }

  const userContent = `Génère le courrier correspondant à cette situation.

TYPE DE COURRIER : ${type_courrier}
SITUATION DÉCRITE : ${situation}
DESTINATAIRE : ${destinataire_nom || '[À COMPLÉTER]'}, ${destinataire_adresse || '[À COMPLÉTER]'}
EXPÉDITEUR : ${expediteur_nom}, ${expediteur_email}, ${expediteur_adresse || ''}, ${expediteur_telephone || ''}
TON SOUHAITÉ : ${ton_souhaite || 'neutre'}
DEMANDE FINALE : ${demande_finale || 'Non précisée'}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ error: data.error?.message || 'Erreur API Anthropic' });
      return;
    }

    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) {
      res.status(502).json({ error: 'Réponse vide de Claude.' });
      return;
    }

    res.status(200).json({ letter: text });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur lors de la génération.' });
  }
};
