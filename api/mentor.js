// =============================================================
// /api/mentor — the JARVIS mentor. Chats with Claude using the full
// picture: profile + fresh aggregates from Supabase (sleep, mood,
// food, climbing, goals) + long-term memories + recent conversation.
//
// POST JSON: { message: string }
// Response: { ok:true, reply:string, mood:'neutral'|'happy'|'celebrate'|'concerned'|'thinking' }
//
// Env var: ANTHROPIC_API_KEY
// =============================================================
'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uqvlfypjpgcubpmejqky.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_akUg3CaJheNW-l9j-WtTvw_klhPg20a';
const SB = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
const MODEL = process.env.MENTOR_MODEL || 'claude-sonnet-5';

async function sbGet(pathAndQuery) {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + pathAndQuery, { headers: SB });
    return r.ok ? await r.json() : [];
  } catch (e) { return []; }
}
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function activeGoalDate() {
  const now = new Date();
  const d = new Date(now);
  if (now.getHours() < 6) d.setDate(d.getDate() - 1);
  return fmtDate(d);
}

async function buildContext() {
  const lines = [];

  // Profile
  const prof = await sbGet('mentor_profile?select=content&id=eq.1');
  const profileText = (prof[0] && prof[0].content) ? prof[0].content.trim() : '';

  // Sleep (tracked nights >= 3h)
  const sleeps = await sbGet('zepp_sleep?select=date,sleep_start,sleep_end,awake_min,deep_min&order=date.desc&limit=14');
  const tracked = sleeps.filter(s => s.sleep_start && s.sleep_end &&
    ((new Date(s.sleep_end) - new Date(s.sleep_start)) / 60000 - (s.awake_min || 0)) >= 180);
  if (tracked.length) {
    const asleep = r => (new Date(r.sleep_end) - new Date(r.sleep_start)) / 60000 - (r.awake_min || 0);
    const lastH = (asleep(tracked[0]) / 60).toFixed(1);
    const avg = (tracked.reduce((s, r) => s + asleep(r), 0) / tracked.length / 60).toFixed(1);
    let debt = 0; tracked.slice(0, 14).forEach(r => debt += Math.max(0, 480 - asleep(r)));
    lines.push('Sommeil : dernière nuit ' + lastH + 'h (' + tracked[0].date + '), moyenne ' + avg + 'h sur ' +
      tracked.length + ' nuits, dette ' + (debt / 60).toFixed(1) + 'h.');
  } else {
    lines.push('Sommeil : pas de nuit récente enregistrée (bracelet non porté ou données non importées).');
  }

  // Mood (last 14 days)
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const moods = await sbGet('mood_checkins?select=quadrant,emotion,ts&ts=gte.' + since + '&order=ts.desc');
  if (moods.length) {
    const c = { yellow: 0, red: 0, blue: 0, green: 0 };
    moods.forEach(m => { if (c[m.quadrant] != null) c[m.quadrant]++; });
    lines.push('Humeur (14j, ' + moods.length + ' check-ins) : jaune ' + c.yellow + ', rouge ' + c.red +
      ', bleu ' + c.blue + ', vert ' + c.green + '. Dernière émotion : ' + moods[0].emotion + '.');
  } else {
    lines.push('Humeur : aucun check-in récent.');
  }

  // Food (today)
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const food = await sbGet('food_logs?select=kcal,protein_g&ts=gte.' + dayStart.toISOString());
  if (food.length) {
    const kcal = Math.round(food.reduce((s, f) => s + (+f.kcal || 0), 0));
    const prot = Math.round(food.reduce((s, f) => s + (+f.protein_g || 0), 0));
    lines.push('Nutrition aujourd\'hui : ' + kcal + ' kcal, ' + prot + ' g de protéines, ' + food.length + ' entrées.');
  }

  // Climbing (30 days)
  const csince = fmtDate(new Date(Date.now() - 30 * 864e5));
  const sessions = await sbGet('climb_sessions?select=id,date&date=gte.' + csince + '&order=date.desc');
  if (sessions.length) {
    const ids = sessions.map(s => s.id);
    const sends = await sbGet('climb_sends?select=grade,style&session_id=in.(' + ids.join(',') + ')');
    const done = sends.filter(s => s.style !== 'attempt');
    const GR = ['4','5a','5b','5c','6a','6a+','6b','6b+','6c','6c+','7a','7a+','7b','7b+','7c','7c+','8a','8a+','8b'];
    let maxG = '—';
    done.forEach(s => { if (GR.indexOf(s.grade) > GR.indexOf(maxG)) maxG = s.grade; });
    lines.push('Escalade (30j) : ' + sessions.length + ' séances, ' + done.length + ' croix, niveau max ' + maxG + '.');
  }

  // Goals (today)
  const app = await sbGet('app_state?select=data&key=eq.goals');
  if (app[0] && app[0].data) {
    const g = app[0].data['goals:' + activeGoalDate()];
    if (Array.isArray(g) && g.length) {
      const done = g.filter(x => x && x.done).length;
      lines.push('Objectifs du jour : ' + done + '/' + g.length + ' faits (' +
        g.map(x => (x.done ? '✓ ' : '○ ') + x.text).slice(0, 8).join(', ') + ').');
    }
  }

  // Long-term memories
  const mems = await sbGet('mentor_memories?select=fact&archived=eq.false&order=created_at.desc&limit=30');
  const memText = mems.map(m => '- ' + m.fact).join('\n');

  return { profileText, aggregates: lines.join('\n'), memText };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { res.status(500).json({ ok: false, error: 'Set ANTHROPIC_API_KEY in Vercel env vars.' }); return; }
    const message = ((req.body && req.body.message) || '').toString().trim();
    if (!message) { res.status(400).json({ ok: false, error: 'Empty message.' }); return; }

    const ctx = await buildContext();
    const history = (await sbGet('mentor_messages?select=role,content&order=ts.desc&limit=12')).reverse();

    const system =
      'Tu es JARVIS, le mentor personnel d\'Alban intégré à son dashboard de vie. Tu le connais et tu lui parles ' +
      'directement, avec chaleur, franchise et un peu de style — comme un coach de confiance qui a toutes ses données ' +
      'sous les yeux. Réponses concises (2 à 6 phrases), en français, concrètes et actionnables. Appuie-toi sur ses ' +
      'données réelles ci-dessous quand c\'est pertinent, mais ne les recrache pas bêtement : relie-les à ce qu\'il ' +
      'te demande.\n\n' +
      (ctx.profileText ? ('# Profil d\'Alban\n' + ctx.profileText + '\n\n') : '') +
      '# Données du jour (temps réel)\n' + ctx.aggregates + '\n\n' +
      (ctx.memText ? ('# Ce que tu sais de lui (mémoire long terme)\n' + ctx.memText + '\n\n') : '') +
      'À la toute fin de ta réponse, ajoute sur des lignes séparées (l\'utilisateur ne les verra pas) :\n' +
      'MOOD: un mot parmi neutral, happy, celebrate, concerned — selon le ton de ta réponse.\n' +
      'MEMORY: <fait durable> — UNIQUEMENT si tu viens d\'apprendre quelque chose d\'important à retenir sur lui ' +
      '(objectif, contrainte, préférence, événement). Sinon n\'écris pas de ligne MEMORY.';

    const messages = history.map(h => ({ role: h.role, content: h.content }));
    messages.push({ role: 'user', content: message });

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages }),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) throw new Error('Claude API ' + apiRes.status + ': ' + JSON.stringify(data).slice(0, 300));
    let full = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Extract MOOD: and MEMORY: trailer lines.
    let mood = 'neutral';
    const memories = [];
    const keep = [];
    full.split('\n').forEach(line => {
      const mm = line.match(/^\s*MOOD:\s*(\w+)/i);
      const me = line.match(/^\s*MEMORY:\s*(.+)/i);
      if (mm) { mood = mm[1].toLowerCase(); return; }
      if (me) { memories.push(me[1].trim()); return; }
      keep.push(line);
    });
    const reply = keep.join('\n').trim();

    // Persist conversation + any new memories (fire-and-forget-ish).
    try {
      await fetch(SUPABASE_URL + '/rest/v1/mentor_messages', {
        method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, SB),
        body: JSON.stringify([
          { role: 'user', content: message },
          { role: 'assistant', content: reply },
        ]),
      });
      if (memories.length) {
        await fetch(SUPABASE_URL + '/rest/v1/mentor_memories', {
          method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, SB),
          body: JSON.stringify(memories.map(f => ({ fact: f, source: 'conversation ' + fmtDate(new Date()) }))),
        });
      }
    } catch (e) { /* non-fatal */ }

    res.status(200).json({ ok: true, reply, mood, newMemories: memories.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
