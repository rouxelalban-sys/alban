// =============================================================
// /api/coach — short, concrete training advice from Claude, using
// the athlete's goal + Helio Strap recovery + recent history.
//
// POST JSON:
//   { domain: 'climb'|'gym', goal, readiness, recovery, breakdown, recent }
// Response:
//   { ok: true, advice: string }
//
// Env var: ANTHROPIC_API_KEY
// =============================================================
'use strict';

const MODEL = process.env.COACH_MODEL || 'claude-sonnet-5';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { res.status(500).json({ ok: false, error: 'Set ANTHROPIC_API_KEY in Vercel env vars.' }); return; }

    const b = req.body || {};
    const domain = b.domain === 'climb' ? 'escalade' : 'musculation';
    const rec = b.recovery || {};
    const readyTxt = b.readiness == null
      ? 'Score de forme indisponible (pas de données bracelet récentes).'
      : 'Score de forme du jour : ' + b.readiness + '/100.';
    const recoveryTxt = rec.none
      ? 'Aucune donnée de bracelet.'
      : [
          rec.lastHours != null ? ('Dernière nuit : ' + Number(rec.lastHours).toFixed(1) + ' h') : null,
          rec.lastScore != null ? ('score sommeil ' + rec.lastScore + '/100') : null,
          rec.debtHours != null ? ('dette de sommeil ' + Number(rec.debtHours).toFixed(1) + ' h sur 14 nuits') : null,
          rec.lastHrv != null ? ('HRV ' + rec.lastHrv + ' vs base ' + Math.round(rec.baseHrv)) : null
        ].filter(Boolean).join(', ') + '.';

    const prompt =
      'Tu es un coach de ' + domain + ' expérimenté, direct et bienveillant. ' +
      'Tu conseilles un athlète pour SA séance d\'aujourd\'hui.\n\n' +
      'Objectif de l\'athlète : ' + (b.goal || 'non précisé') + '\n' +
      readyTxt + '\n' +
      'Récupération : ' + recoveryTxt + '\n' +
      (b.recent ? ('Historique récent :\n' + String(b.recent).slice(0, 1200) + '\n') : '') +
      '\nDonne un conseil pour la séance d\'aujourd\'hui : 4 à 6 phrases max, en français, ' +
      'concret et actionnable (type de séance, intensité/charge, ce qu\'il faut éviter vu la récup, ' +
      'et un lien avec son objectif). Pas de liste à puces, pas de préambule, parle-lui directement.';

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await apiRes.json();
    if (!apiRes.ok) throw new Error('Claude API ' + apiRes.status + ': ' + JSON.stringify(data).slice(0, 300));
    const advice = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('').trim();
    res.status(200).json({ ok: true, advice: advice || 'Séance libre aujourd\'hui — écoute ton corps.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
