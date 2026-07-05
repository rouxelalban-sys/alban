// =============================================================
// /api/food-vision — estimates macros from a meal photo or a text
// description using Claude vision.
//
// POST JSON:
//   { "image": "<base64, no data-url prefix>", "mediaType": "image/jpeg" }
//   or
//   { "text": "150g riz, 2 oeufs, une pomme" }
//
// Response:
//   { ok: true, items: [{ name, quantity, kcal, protein_g, carbs_g, fat_g }] }
//
// Env var (Vercel -> Settings -> Environment Variables):
//   ANTHROPIC_API_KEY
// =============================================================
'use strict';

const MODEL = process.env.FOOD_MODEL || 'claude-sonnet-5';

const INSTRUCTIONS =
  'Tu es un nutritionniste. Estime les aliments et leurs macros.\n' +
  'Réponds UNIQUEMENT avec un tableau JSON, sans texte autour, sans balises de code.\n' +
  'Chaque élément: {"name": string (français, court), "quantity": string (portion estimée, ex "150 g", "1 bol"), ' +
  '"kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number}.\n' +
  'Estime des portions réalistes. Si un plat composé est reconnaissable, découpe-le en 2-5 composants max. ' +
  'Si rien de comestible: [].';

function parseItems(textOut) {
  // Strip accidental code fences, then find the JSON array.
  let t = textOut.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in model output: ' + t.slice(0, 160));
  const arr = JSON.parse(t.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('Model output is not an array');
  return arr
    .filter(x => x && typeof x.name === 'string')
    .map(x => ({
      name: String(x.name).slice(0, 80),
      quantity: x.quantity != null ? String(x.quantity).slice(0, 40) : null,
      kcal: Number(x.kcal) || 0,
      protein_g: Number(x.protein_g) || 0,
      carbs_g: Number(x.carbs_g) || 0,
      fat_g: Number(x.fat_g) || 0,
    }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      res.status(500).json({ ok: false, error: 'Set ANTHROPIC_API_KEY in Vercel env vars.' });
      return;
    }

    const body = req.body || {};
    const content = [];
    if (body.image) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: body.mediaType || 'image/jpeg',
          data: body.image,
        },
      });
      content.push({ type: 'text', text: INSTRUCTIONS + '\n\nVoici la photo du repas.' });
    } else if (body.text) {
      content.push({ type: 'text', text: INSTRUCTIONS + '\n\nDescription du repas: ' + String(body.text).slice(0, 500) });
    } else {
      res.status(400).json({ ok: false, error: 'Provide "image" (base64) or "text".' });
      return;
    }

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content }],
      }),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) {
      throw new Error('Claude API ' + apiRes.status + ': ' + JSON.stringify(data).slice(0, 300));
    }
    const textOut = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const items = parseItems(textOut);
    res.status(200).json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
