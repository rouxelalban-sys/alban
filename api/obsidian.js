// =============================================================
// /api/obsidian — bridge to the Obsidian vault mirrored on GitHub
// (via the obsidian-git plugin pushing to a private repo).
//
// GET  ?op=list                 -> { ok, notes:[{path,size}], folders }
// GET  ?op=read&path=...        -> { ok, path, content }
// GET  ?op=search&q=...         -> { ok, results:[{path, fragment}] }
// GET  ?op=daily                -> creates Journal/YYYY-MM-DD.md with real
//                                  JARVIS data (called by the daily cron;
//                                  never overwrites an existing note)
// POST { op:'create', folder, title, content } -> commits a new note
//
// Env vars (Vercel): GITHUB_TOKEN (fine-grained, Contents read/write on the
// vault repo), VAULT_REPO ("user/repo"), VAULT_BRANCH (default "main").
// =============================================================
'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uqvlfypjpgcubpmejqky.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_akUg3CaJheNW-l9j-WtTvw_klhPg20a';
const SB = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };

function ghHeaders() {
  return {
    Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'jarvis-dashboard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
function repo() { return process.env.VAULT_REPO; }

// Resolve the branch: use VAULT_BRANCH if set, else the repo's real
// default branch (handles main vs master automatically). Also gives a
// clear error if the repo itself isn't reachable with this token.
let _branch = null;
async function getBranch() {
  if (_branch) return _branch;
  if (process.env.VAULT_BRANCH) { _branch = process.env.VAULT_BRANCH; return _branch; }
  const r = await gh('/repos/' + repo());
  if (r.status === 404) {
    throw new Error('Repo introuvable ou token sans accès : "' + repo() +
      '". Vérifie VAULT_REPO (format exact owner/repo, ex rouxelalban-sys/vault) et que ton token fine-grained inclut CE repo avec la permission Contents: Read and write.');
  }
  if (r.status !== 200) throw new Error('GitHub /repos ' + r.status + ': ' + JSON.stringify(r.body).slice(0, 150));
  _branch = (r.body && r.body.default_branch) || 'main';
  return _branch;
}

async function gh(path, opts) {
  const res = await fetch('https://api.github.com' + path, Object.assign({ headers: ghHeaders() }, opts || {}));
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---- ops ----------------------------------------------------
async function opList() {
  const b = await getBranch();
  const r = await gh('/repos/' + repo() + '/git/trees/' + b + '?recursive=1');
  if (r.status === 404) {
    throw new Error('Branche "' + b + '" vide ou absente sur ' + repo() +
      '. Le repo existe mais le push n\'a probablement pas abouti (repo vide), ou la branche s\'appelle autrement. Vérifie sur GitHub que tes notes sont bien là.');
  }
  if (r.status !== 200) throw new Error('GitHub tree ' + r.status + ': ' + JSON.stringify(r.body).slice(0, 200));
  const notes = (r.body.tree || [])
    .filter(x => x.type === 'blob' && /\.md$/i.test(x.path) && !x.path.startsWith('.'))
    .map(x => ({ path: x.path, size: x.size || 0 }));
  const folders = [...new Set(notes.map(n => n.path.includes('/') ? n.path.split('/')[0] : ''))].sort();
  return { notes, folders, count: notes.length };
}

async function opRead(path) {
  const r = await gh('/repos/' + repo() + '/contents/' + encodeURI(path) + '?ref=' + (await getBranch()));
  if (r.status !== 200) throw new Error('GitHub read ' + r.status);
  const content = Buffer.from(r.body.content || '', 'base64').toString('utf8');
  return { path, content };
}

async function opSearch(q) {
  const r = await gh('/search/code?q=' + encodeURIComponent(q + ' repo:' + repo()));
  if (r.status !== 200) {
    // Code search can be unavailable on some repos — degrade gracefully.
    return { results: [], warning: 'search ' + r.status };
  }
  const results = (r.body.items || []).slice(0, 20).map(it => ({ path: it.path }));
  return { results };
}

async function writeNote(path, content, message, allowOverwrite) {
  const b = await getBranch();
  // Need the sha when the file already exists.
  let sha;
  const existing = await gh('/repos/' + repo() + '/contents/' + encodeURI(path) + '?ref=' + b);
  if (existing.status === 200) {
    if (!allowOverwrite) return { skipped: true, reason: 'exists' };
    sha = existing.body.sha;
  }
  const r = await gh('/repos/' + repo() + '/contents/' + encodeURI(path), {
    method: 'PUT',
    body: JSON.stringify({
      message: message || ('JARVIS: ' + path),
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: b,
      sha,
    }),
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error('GitHub write ' + r.status + ': ' + JSON.stringify(r.body).slice(0, 200));
  }
  return { written: true, path };
}

function slugify(s) {
  return s.trim().replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').slice(0, 80) || 'note';
}

// ---- daily note with real data ------------------------------
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function sbGet(q) {
  try { const r = await fetch(SUPABASE_URL + '/rest/v1/' + q, { headers: SB }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
}
async function opDaily() {
  const today = fmtDate(new Date());
  const path = 'Journal/' + today + '.md';
  const lines = ['# ' + today, '', '## Données JARVIS'];

  const sleeps = await sbGet('zepp_sleep?select=date,sleep_start,sleep_end,awake_min,deep_min,light_min,rem_min&order=date.desc&limit=1');
  const s = sleeps[0];
  if (s && s.sleep_start && s.sleep_end) {
    const asleep = ((new Date(s.sleep_end) - new Date(s.sleep_start)) / 60000 - (s.awake_min || 0)) / 60;
    if (asleep >= 3) {
      let l = '- 🛌 Sommeil (' + s.date + ') : ' + asleep.toFixed(1) + 'h';
      if (s.deep_min) l += ' (profond ' + Math.round(s.deep_min) + 'min, REM ' + Math.round(s.rem_min || 0) + 'min)';
      lines.push(l);
    }
  }
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const moods = await sbGet('mood_checkins?select=emotion,quadrant&ts=gte.' + dayStart.toISOString());
  if (moods.length) lines.push('- 🎭 Humeur : ' + moods.map(m => m.emotion).join(', '));
  const food = await sbGet('food_logs?select=kcal,protein_g&ts=gte.' + dayStart.toISOString());
  if (food.length) {
    const kcal = Math.round(food.reduce((a, f) => a + (+f.kcal || 0), 0));
    const prot = Math.round(food.reduce((a, f) => a + (+f.protein_g || 0), 0));
    lines.push('- 🍽 Nutrition : ' + kcal + ' kcal, ' + prot + ' g protéines');
  }
  const sess = await sbGet('climb_sessions?select=id,kind,location&date=eq.' + today);
  if (sess.length) lines.push('- 🧗 Escalade : ' + sess.length + ' séance(s) — ' + sess.map(x => x.kind + (x.location ? ' @ ' + x.location : '')).join(', '));
  const app = await sbGet('app_state?select=data&key=eq.goals');
  const goals = app[0] && app[0].data && app[0].data['goals:' + today];
  if (Array.isArray(goals) && goals.length) {
    lines.push('- 🎯 Objectifs : ' + goals.filter(g => g.done).length + '/' + goals.length);
    goals.forEach(g => lines.push('    - [' + (g.done ? 'x' : ' ') + '] ' + g.text));
  }
  lines.push('', '## Notes', '- ', '');
  const result = await writeNote(path, lines.join('\n'), 'JARVIS daily note ' + today, false);
  return Object.assign({ path }, result);
}

// ---- handler -------------------------------------------------
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    if (!process.env.GITHUB_TOKEN || !repo()) {
      res.status(500).json({ ok: false, error: 'Set GITHUB_TOKEN and VAULT_REPO in Vercel env vars.', setup: true });
      return;
    }
    const op = (req.method === 'POST' ? (req.body && req.body.op) : (req.query && req.query.op)) || 'list';

    if (req.method === 'POST' && op === 'create') {
      const b = req.body || {};
      const folder = (b.folder || 'Inbox').replace(/[^\w\- /]/g, '').replace(/^\/+|\/+$/g, '') || 'Inbox';
      const title = slugify(b.title || ('Capture ' + new Date().toISOString().slice(0, 16).replace('T', ' ')));
      const path = folder + '/' + title + '.md';
      const out = await writeNote(path, (b.content || '').toString(), 'JARVIS capture: ' + title, false);
      if (out.skipped) { // title collision — add a timestamp
        const p2 = folder + '/' + title + ' ' + Date.now() + '.md';
        res.status(200).json(Object.assign({ ok: true }, await writeNote(p2, (b.content || '').toString(), 'JARVIS capture', false)));
        return;
      }
      res.status(200).json(Object.assign({ ok: true }, out));
      return;
    }

    if (op === 'list')   { res.status(200).json(Object.assign({ ok: true }, await opList())); return; }
    if (op === 'read')   { res.status(200).json(Object.assign({ ok: true }, await opRead((req.query.path || '').toString()))); return; }
    if (op === 'search') { res.status(200).json(Object.assign({ ok: true }, await opSearch((req.query.q || '').toString()))); return; }
    if (op === 'daily')  { res.status(200).json(Object.assign({ ok: true }, await opDaily())); return; }

    res.status(400).json({ ok: false, error: 'Unknown op' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
