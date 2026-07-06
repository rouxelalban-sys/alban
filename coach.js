// =============================================================
// Shared training coach widget. Include on any sport page:
//   <script>window.COACH_DOMAIN = 'gym';</script>   (optional; else inferred)
//   <script src="coach.js" defer></script>
// It self-injects a card into #coachMount (or after the topbar),
// reads recovery from the Helio Strap (Supabase zepp_sleep/zepp_daily),
// computes a daily readiness score, and adapts the session to the
// user's goal. An optional AI layer (/api/coach) refines the advice
// when ANTHROPIC_API_KEY is configured on Vercel.
// =============================================================
(function () {
  'use strict';

  var SUPABASE_URL = 'https://uqvlfypjpgcubpmejqky.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_akUg3CaJheNW-l9j-WtTvw_klhPg20a';
  var SB = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };

  function domain() {
    if (window.COACH_DOMAIN) return window.COACH_DOMAIN;
    var p = location.pathname.toLowerCase();
    if (p.indexOf('climb') !== -1) return 'climb';
    return 'gym';
  }
  var DOMAIN = domain();
  var GOAL_KEY = 'sport_goal_' + DOMAIN;

  // ---- styles (self-contained so it works on any page theme) ----
  var css = ''
    + '.coach{position:relative;border:1px solid rgba(79,216,255,0.16);border-radius:14px;'
    + 'background:rgba(6,12,22,0.6);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);'
    + 'box-shadow:0 12px 40px rgba(0,0,0,0.5),inset 0 0 30px rgba(79,216,255,0.04);'
    + 'padding:18px;margin:0 auto 18px;max-width:1100px;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;color:#9FB6C4;}'
    + '.coach-top{display:flex;align-items:center;gap:16px;flex-wrap:wrap;}'
    + '.coach-ring{position:relative;width:92px;height:92px;flex-shrink:0;}'
    + '.coach-ring svg{width:100%;height:100%;transform:rotate(-90deg);}'
    + '.coach-ring-num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}'
    + '.coach-ring-num b{font-size:26px;font-weight:800;color:#EAF6FB;font-variant-numeric:tabular-nums;line-height:1;}'
    + '.coach-ring-num span{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:8px;letter-spacing:0.14em;text-transform:uppercase;color:#5E7686;margin-top:3px;}'
    + '.coach-body{flex:1;min-width:200px;}'
    + '.coach-eyebrow{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9.5px;font-weight:800;letter-spacing:0.2em;text-transform:uppercase;color:#5E7686;margin-bottom:4px;}'
    + '.coach-verdict{font-size:16px;font-weight:700;color:#EAF6FB;margin-bottom:6px;}'
    + '.coach-rec{font-size:13.5px;line-height:1.55;color:#9FB6C4;}'
    + '.coach-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}'
    + '.coach-chip{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9.5px;letter-spacing:0.08em;text-transform:uppercase;'
    + 'padding:4px 9px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);color:#5E7686;}'
    + '.coach-chip b{color:#9FB6C4;font-weight:700;}'
    + '.coach-goal{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center;}'
    + '.coach-goal input{flex:1;min-width:160px;padding:10px 12px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;'
    + 'background:rgba(0,0,0,0.3);color:#EAF6FB;font-family:inherit;font-size:13px;outline:none;}'
    + '.coach-goal input:focus{border-color:rgba(79,216,255,0.45);}'
    + '.coach-btn{border:1px solid rgba(79,216,255,0.3);background:rgba(79,216,255,0.12);color:#9BEBFF;'
    + 'border-radius:10px;padding:10px 14px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;cursor:pointer;white-space:nowrap;}'
    + '.coach-btn:hover{background:rgba(79,216,255,0.2);}'
    + '.coach-btn:disabled{opacity:0.5;cursor:wait;}'
    + '.coach-ai{margin-top:12px;padding:12px 14px;border-radius:10px;background:rgba(79,216,255,0.06);'
    + 'border:1px solid rgba(79,216,255,0.14);font-size:13.5px;line-height:1.6;color:#EAF6FB;display:none;white-space:pre-wrap;}'
    + '.coach-ai.show{display:block;}'
    + '.coach-muted{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#5E7686;margin-top:8px;}';

  function inject() {
    if (document.getElementById('coach-style')) return;
    var s = document.createElement('style'); s.id = 'coach-style'; s.textContent = css;
    document.head.appendChild(s);

    var mount = document.getElementById('coachMount');
    var card = document.createElement('div');
    card.className = 'coach';
    card.innerHTML = ''
      + '<div class="coach-top">'
      + '  <div class="coach-ring"><svg viewBox="0 0 100 100">'
      + '    <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(79,216,255,0.1)" stroke-width="8"/>'
      + '    <circle id="coachArc" cx="50" cy="50" r="42" fill="none" stroke="#4FD8FF" stroke-width="8" stroke-linecap="round" stroke-dasharray="264" stroke-dashoffset="264" style="transition:stroke-dashoffset 0.8s cubic-bezier(0.22,1,0.36,1),stroke 0.5s;"/>'
      + '  </svg><div class="coach-ring-num"><b id="coachScore">–</b><span>Forme</span></div></div>'
      + '  <div class="coach-body">'
      + '    <div class="coach-eyebrow">Coach ' + (DOMAIN === 'climb' ? 'Escalade' : 'Gym') + ' · Helio Strap</div>'
      + '    <div class="coach-verdict" id="coachVerdict">Lecture de ta récupération…</div>'
      + '    <div class="coach-rec" id="coachRec">—</div>'
      + '    <div class="coach-chips" id="coachChips"></div>'
      + '  </div>'
      + '</div>'
      + '<div class="coach-goal">'
      + '  <input id="coachGoal" placeholder="' + (DOMAIN === 'climb' ? 'Ton objectif (ex : enchaîner mon premier 7a)…' : 'Ton objectif (ex : prise de force, +5kg développé couché)…') + '">'
      + '  <button class="coach-btn" id="coachAsk">✨ Conseil du jour</button>'
      + '</div>'
      + '<div class="coach-ai" id="coachAi"></div>'
      + '<div class="coach-muted" id="coachSource">—</div>';

    if (mount) mount.appendChild(card);
    else {
      var tb = document.getElementById('topbar');
      if (tb && tb.parentNode) tb.parentNode.insertBefore(card, tb.nextSibling);
      else document.body.insertBefore(card, document.body.firstChild);
    }

    var goalEl = document.getElementById('coachGoal');
    try { goalEl.value = localStorage.getItem(GOAL_KEY) || ''; } catch (e) {}
    goalEl.addEventListener('change', function () { try { localStorage.setItem(GOAL_KEY, goalEl.value); } catch (e) {} });
    document.getElementById('coachAsk').addEventListener('click', askAI);
  }

  // ---- recovery + readiness ----
  var recovery = null, readiness = null, breakdown = null;

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function asleepMin(r) {
    if (!r.sleep_start || !r.sleep_end) return 0;
    return (new Date(r.sleep_end) - new Date(r.sleep_start)) / 60000 - (r.awake_min || 0);
  }

  async function loadRecovery() {
    var sleeps = [], daily = [];
    try {
      var r1 = await fetch(SUPABASE_URL + '/rest/v1/zepp_sleep?select=date,sleep_start,sleep_end,awake_min,deep_min,score&order=date.desc&limit=14', { headers: SB });
      if (r1.ok) sleeps = await r1.json();
      var r2 = await fetch(SUPABASE_URL + '/rest/v1/zepp_daily?select=date,resting_hr,hrv&order=date.desc&limit=14', { headers: SB });
      if (r2.ok) daily = await r2.json();
    } catch (e) {}

    var tracked = sleeps.filter(function (s) { return asleepMin(s) >= 180; });
    if (!tracked.length) { recovery = { none: true }; return; }

    var last = tracked[0];
    var lastH = asleepMin(last) / 60;
    var debt = 0;
    tracked.slice(0, 14).forEach(function (s) { debt += Math.max(0, 480 - asleepMin(s)); });
    debt = debt / 60;

    // Optional HRV (populated only if the sync captured it).
    var hrvs = daily.map(function (d) { return d.hrv; }).filter(function (x) { return x != null; });
    var lastHrv = hrvs.length ? hrvs[0] : null;
    var baseHrv = hrvs.length ? hrvs.reduce(function (s, x) { return s + x; }, 0) / hrvs.length : null;

    var stale = (Date.now() - new Date(last.sleep_end).getTime()) > 36 * 3600 * 1000;

    recovery = {
      lastDate: last.date, lastHours: lastH, lastScore: last.score,
      lastDeepMin: last.deep_min, debtHours: debt,
      lastHrv: lastHrv, baseHrv: baseHrv, nights: tracked.length, stale: stale
    };
  }

  function computeReadiness() {
    if (!recovery || recovery.none) { readiness = null; return; }
    var parts = [];
    parts.push([clamp(recovery.lastHours / 8, 0, 1), 0.4, 'sommeil ' + recovery.lastHours.toFixed(1) + 'h']);
    var sq = recovery.lastScore != null
      ? clamp(recovery.lastScore / 100, 0, 1)
      : clamp((recovery.lastDeepMin || 0) / (recovery.lastHours * 60 * 0.2), 0, 1);
    parts.push([sq, 0.3, recovery.lastScore != null ? ('score ' + recovery.lastScore) : 'sommeil profond']);
    parts.push([1 - clamp(recovery.debtHours / 10, 0, 1), 0.3, 'dette ' + recovery.debtHours.toFixed(1) + 'h']);
    if (recovery.lastHrv != null && recovery.baseHrv) {
      var hv = clamp(0.5 + (recovery.lastHrv - recovery.baseHrv) / recovery.baseHrv, 0, 1);
      parts.push([hv, 0.35, 'HRV ' + recovery.lastHrv]);
    }
    var wsum = parts.reduce(function (s, p) { return s + p[1]; }, 0);
    var score = parts.reduce(function (s, p) { return s + p[0] * p[1]; }, 0) / wsum;
    readiness = Math.round(score * 100);
    breakdown = parts.map(function (p) { return p[2]; });
    if (recovery.stale) readiness = null; // don't trust old data
  }

  // ---- rule-based recommendation ----
  var REC = {
    climb: {
      high: ['Journée de projet 🔥', 'Tu es frais : attaque tes voies/blocs limites, essais maximaux, repos longs entre les tentatives. C\'est le jour pour tenter le cran au-dessus.'],
      mid:  ['Séance normale', 'Travaille tes projets en cours puis du volume à vue 1–2 crans sous ton max. Soigne les pieds et la respiration.'],
      low:  ['Récup active 🌙', 'Récupération incomplète : technique, déplacements, volume facile (2–3 crans sous ton max). Évite les gros blocs à froid et le tout-force.'],
      none: ['Enregistre une séance', 'Porte ton Helio Strap la nuit pour que j\'adapte tes séances à ta récup. En attendant : échauffe-toi bien et vise du volume propre.']
    },
    gym: {
      high: ['Jour lourd 🔥', 'Tu es récupéré : monte en charge sur tes gros mouvements (force, 3–5 reps), tu peux viser un PR aujourd\'hui.'],
      mid:  ['Séance standard', 'Volume d\'hypertrophie 8–12 reps à RPE 7–8, progression légère sur les charges. Rien de héroïque, de la régularité.'],
      low:  ['Deload 🌙', 'Récup incomplète : réduis le volume ~40 %, reste technique (RPE ≤ 6), ou repos complet si le corps le demande. Ne force pas un PR aujourd\'hui.'],
      none: ['Enregistre une séance', 'Porte ton Helio Strap la nuit pour que j\'adapte tes charges à ta récup. En attendant : progression légère et technique propre.']
    }
  };

  function bucket() {
    if (readiness == null) return 'none';
    if (readiness >= 70) return 'high';
    if (readiness >= 45) return 'mid';
    return 'low';
  }

  function render() {
    var arc = document.getElementById('coachArc');
    var scoreEl = document.getElementById('coachScore');
    var b = bucket();
    var color = readiness == null ? '#5E7686' : (b === 'high' ? '#4FD8FF' : b === 'mid' ? '#F2C063' : '#FF5C4D');
    if (readiness == null) {
      arc.setAttribute('stroke-dashoffset', 264); scoreEl.textContent = '–';
    } else {
      arc.setAttribute('stroke-dashoffset', 264 * (1 - readiness / 100));
      scoreEl.textContent = readiness;
    }
    arc.setAttribute('stroke', color);
    scoreEl.style.color = readiness == null ? '#5E7686' : '#EAF6FB';

    var rec = REC[DOMAIN][b];
    document.getElementById('coachVerdict').textContent = rec[0];
    document.getElementById('coachRec').textContent = rec[1];

    var chips = document.getElementById('coachChips');
    chips.innerHTML = '';
    if (breakdown && readiness != null) {
      breakdown.forEach(function (t) {
        var c = document.createElement('span'); c.className = 'coach-chip'; c.textContent = t;
        chips.appendChild(c);
      });
    }
    var src = document.getElementById('coachSource');
    if (recovery && recovery.none) src.textContent = 'Aucune donnée bracelet — conseils génériques.';
    else if (recovery && recovery.stale) src.textContent = 'Données bracelet trop anciennes (' + recovery.lastDate + ') — remets ton Helio Strap.';
    else if (recovery) src.textContent = 'Basé sur ta nuit du ' + recovery.lastDate + ' · ' + recovery.nights + ' nuits suivies.';
  }

  // ---- optional AI coach ----
  async function askAI() {
    var btn = document.getElementById('coachAsk');
    var box = document.getElementById('coachAi');
    var goal = document.getElementById('coachGoal').value.trim();
    try { localStorage.setItem(GOAL_KEY, goal); } catch (e) {}
    btn.disabled = true; box.classList.add('show'); box.textContent = 'JARVIS réfléchit à ta séance…';

    var ctx = (typeof window.coachContext === 'function') ? window.coachContext() : '';
    try {
      var res = await fetch('/api/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: DOMAIN, goal: goal, readiness: readiness,
          recovery: recovery, breakdown: breakdown, recent: ctx
        })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      box.textContent = data.advice;
    } catch (e) {
      box.textContent = 'Coach IA indisponible (' + e.message + ').\nAjoute ANTHROPIC_API_KEY dans Vercel pour l\'activer. En attendant, suis la reco ci-dessus.';
    } finally {
      btn.disabled = false;
    }
  }

  async function boot() {
    inject();
    await loadRecovery();
    computeReadiness();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
