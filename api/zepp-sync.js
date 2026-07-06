// =============================================================
// /api/zepp-sync — pulls sleep + daily activity from the Zepp
// (Huami) cloud into Supabase. Runs as a daily Vercel cron
// (see vercel.json) and can be called manually:
//   /api/zepp-sync            -> last 7 days
//   /api/zepp-sync?days=30    -> backfill 30 days
//   /api/zepp-sync?debug=1    -> include raw API payload in the response
//
// Env vars (Vercel -> Settings -> Environment Variables):
//   ZEPP_EMAIL     — Zepp app account email
//   ZEPP_PASSWORD  — Zepp app account password
//
// This uses the UNOFFICIAL Zepp/Huami API. Auth flow updated Jul 2026
// to the encrypted v2 login (endpoints migrated huami.com -> zepp.com,
// credentials AES-128-CBC encrypted, 303 redirect returns the tokens),
// mirroring argrento/huami-token v0.8+. It can break again if Zepp
// changes things; the raw payload is stored in the `raw` column so
// history can always be re-parsed.
// =============================================================
'use strict';

const crypto = require('crypto');

// Same Supabase project as sync.js/topbar.js (publishable key is
// already public in the repo; RLS intentionally disabled).
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uqvlfypjpgcubpmejqky.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_akUg3CaJheNW-l9j-WtTvw_klhPg20a';

const REDIRECT_URI = 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html';

// AES-128-CBC params for the encrypted credential payload (from
// argrento/huami-token). The login body is urlencoded, then encrypted.
const ZEPP_KEY = Buffer.from('xeNtBVqzDc6tuNTh');
const ZEPP_IV  = Buffer.from('MAAAYAAAAAAAAABg');

const TOKENS_HEADERS = {
  app_name: 'com.huami.midong',
  appname: 'com.huami.midong',
  cv: '151689_9.12.5',
  v: '2.0',
  appplatform: 'android_phone',
  vb: '202509151347',
  vn: '9.12.5',
  'user-agent': 'Zepp/9.12.5 (Pixel 4; Android 12; Density/2.75)',
  'x-hm-ekv': '1',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
};
const LOGIN_HEADERS = {
  app_name: 'com.huami.webapp',
  appname: 'com.huami.webapp',
  origin: 'https://user.zepp.com',
  referer: 'https://user.zepp.com/',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.5',
};

function fmtDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function encryptPayload(str) {
  const c = crypto.createCipheriv('aes-128-cbc', ZEPP_KEY, ZEPP_IV);
  return Buffer.concat([c.update(Buffer.from(str, 'utf8')), c.final()]);
}

// ---- Step 1: email+password -> access + refresh tokens (303 redirect) ----
async function getAccessToken(email, password) {
  // Order matters to match the reference payload; token is sent twice.
  const p = new URLSearchParams();
  p.append('emailOrPhone', email);
  p.append('state', 'REDIRECTION');
  p.append('client_id', 'HuaMi');
  p.append('password', password);
  p.append('redirect_uri', REDIRECT_URI);
  p.append('region', 'us-west-2');
  p.append('token', 'access');
  p.append('token', 'refresh');
  p.append('country_code', 'US');

  const res = await fetch('https://api-user-us2.zepp.com/v2/registrations/tokens', {
    method: 'POST',
    redirect: 'manual',
    headers: TOKENS_HEADERS,
    body: encryptPayload(p.toString()),
  });

  if (res.status !== 303 && res.status !== 302) {
    const body = await res.text().catch(() => '');
    throw new Error('Zepp token request expected 303, got ' + res.status +
      '. ' + body.slice(0, 200) +
      (res.status === 429 ? ' (429 = the account/IP is rate-limited or the credentials were rejected — wait a few minutes and retry).' : ''));
  }
  const location = res.headers.get('location') || '';
  const access = new URL(location, REDIRECT_URI).searchParams.get('access');
  if (!access) {
    throw new Error('Zepp token redirect had no access token. Location: ' + location.slice(0, 200));
  }
  return access;
}

// ---- Step 2: access token -> app_token + user_id ----
async function loginWithToken(access) {
  const p = new URLSearchParams({
    code: access,
    device_id: crypto.randomUUID(),
    device_model: 'android_phone',
    app_version: '9.12.5',
    dn: 'api-mifit.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,auth.zepp.com,api-analytics.zepp.com',
    third_name: 'huami',
    source: 'com.huami.watch.hmwatchmanager:9.12.5:151689',
    app_name: 'com.huami.midong',
    country_code: 'US',
    grant_type: 'access_token',
    allow_registration: 'false',
    lang: 'en',
    countryState: 'US-NY',
  });
  const res = await fetch('https://api-mifit-us2.zepp.com/v2/client/login', {
    method: 'POST',
    headers: LOGIN_HEADERS,
    body: p,
  });
  const data = await res.json().catch(() => ({}));
  const info = data && data.token_info;
  if (!info || !info.app_token || !info.user_id) {
    throw new Error('Zepp login (step 2) failed, status ' + res.status + ': ' +
      JSON.stringify(data).slice(0, 300));
  }
  return { appToken: info.app_token, userId: info.user_id };
}

// ---- Step 3: fetch daily band summaries ----
async function fetchBandData(auth, fromDate, toDate) {
  // Try region clusters in turn (account region is set at signup).
  const hosts = [
    'https://api-mifit-us2.zepp.com',
    'https://api-mifit-de2.zepp.com',
    'https://api-mifit.zepp.com',
    'https://api-mifit-de2.huami.com',
    'https://api-mifit.huami.com',
  ];
  const dataHeaders = {
    apptoken: auth.appToken,
    appname: 'com.huami.midong',
    appplatform: 'android_phone',
    'user-agent': 'Zepp/9.12.5 (Pixel 4; Android 12; Density/2.75)',
    cv: '151689_9.12.5',
    v: '2.0',
  };
  let lastErr = null, fallback = null;
  for (const host of hosts) {
    try {
      const url = host + '/v1/data/band_data.json?' + new URLSearchParams({
        query_type: 'detail',           // 'detail' returns real sleep/HR; 'summary' is empty on Zepp OS bands
        device_type: 'android_phone',
        userid: auth.userId,
        from_date: fromDate,
        to_date: toDate,
      });
      const res = await fetch(url, { headers: dataHeaders });
      if (res.ok) {
        const body = await res.json();
        if (body && Array.isArray(body.data)) {
          // A host can answer 200 with only empty shells; prefer one that
          // actually carries sleep/step data, else keep it as a fallback.
          if (hasRealData(body.data)) return body.data;
          if (!fallback) fallback = body.data;
        } else {
          lastErr = new Error('Unexpected band_data body from ' + host + ': ' + JSON.stringify(body).slice(0, 200));
        }
      } else {
        lastErr = new Error('band_data ' + res.status + ' on ' + host);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (fallback) return fallback;
  throw lastErr || new Error('No band_data host returned data');
}

// True if any day carries a real night or step count (not an empty shell).
function hasRealData(days) {
  for (const item of days) {
    try {
      const s = JSON.parse(Buffer.from(item.summary, 'base64').toString('utf8'));
      if (s.slp && s.slp.ed > s.slp.st) return true;
      if (s.stp && (s.stp.ttl || 0) > 0) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

// ---- Parse one day's base64 summary into our table rows ----
function parseDay(item) {
  let summary = null;
  try {
    summary = JSON.parse(Buffer.from(item.summary, 'base64').toString('utf8'));
  } catch (e) {
    return { date: item.date_time, sleep: null, daily: null, parseError: String(e) };
  }

  const slp = summary.slp || null;
  const stp = summary.stp || null;

  let sleep = null;
  // Only a genuine night: end must be strictly after start (nights the
  // band wasn't worn come back with st === ed and everything zeroed).
  if (slp && slp.st && slp.ed && slp.ed > slp.st) {
    // stage modes (Gadgetbridge mapping): 4 light, 5 deep, 7 awake, 8 REM
    let rem = 0, awake = 0;
    (slp.stage || []).forEach(s => {
      const mins = (s.stop - s.start);
      if (s.mode === 8) rem += mins;
      if (s.mode === 7) awake += mins;
    });
    sleep = {
      date: item.date_time,
      sleep_start: new Date(slp.st * 1000).toISOString(),
      sleep_end: new Date(slp.ed * 1000).toISOString(),
      deep_min: slp.dp != null ? slp.dp : null,
      light_min: slp.lt != null ? slp.lt : null,
      rem_min: rem || null,
      awake_min: awake || (slp.wk != null ? slp.wk : null),
      score: slp.ss != null ? slp.ss : null,
      raw: summary,
    };
  }

  let daily = null;
  if (stp) {
    daily = {
      date: item.date_time,
      steps: stp.ttl != null ? stp.ttl : null,
      distance_m: stp.dis != null ? stp.dis : null,
      calories: stp.cal != null ? stp.cal : null,
      raw: summary,
    };
  }

  return { date: item.date_time, sleep, daily };
}

// ---- Supabase REST upsert (no npm dependencies) ----
async function upsert(table, rows) {
  if (!rows.length) return 0;
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?on_conflict=date', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error('Supabase upsert ' + table + ' failed: ' + res.status + ' ' +
      (await res.text()).slice(0, 300));
  }
  return rows.length;
}

// Bump this whenever the auth flow changes, so a response instantly
// reveals whether Vercel is serving the current code.
const VERSION = 'zepp-auth-v2-2026-07-05';

// ---- Probe: discover which /events eventType holds Zepp OS sleep ----
// Newer Zepp OS bands (Helio Strap) don't populate the legacy band_data
// sleep; their health data lives under /users/{id}/events as typed events.
// We don't know the exact sleep eventType, so try a bunch and report which
// one returns items. Run once with ?probe=1 and read the result.
async function probeEvents(auth, fromMs, toMs) {
  const host = 'https://api-mifit.zepp.com'; // all regions share the backend
  const headers = {
    apptoken: auth.appToken,
    appname: 'com.huami.midong',
    appplatform: 'android_phone',
    'user-agent': 'Zepp/9.12.5 (Pixel 4; Android 12; Density/2.75)',
    cv: '151689_9.12.5', v: '2.0',
  };
  async function q(params) {
    const url = host + '/users/' + auth.userId + '/events?' + new URLSearchParams(
      Object.assign({ from: String(fromMs), to: String(toMs), limit: '200', timeZone: 'Europe/Paris' }, params));
    const r = await fetch(url, { headers });
    let body = null;
    try { body = await r.json(); } catch (e) {}
    const items = body && Array.isArray(body.items) ? body.items : null;
    return { status: r.status, items, body };
  }

  const out = {};

  // 1a. No eventType — capture the FULL error message (may list valid types).
  try {
    const all = await q({});
    out.noFilter = all.items
      ? { count: all.items.length, types: [...new Set(all.items.map(i => i.eventType))] }
      : { status: all.status, body: JSON.stringify(all.body).slice(0, 500) };
  } catch (e) { out.noFilter = { error: String(e && e.message || e) }; }

  // 1b. Deliberately invalid eventType — does the API reject (400 + list) or
  //     silently return empty? Tells us if "0 items" means valid-but-empty.
  try {
    const bad = await q({ eventType: 'zzz_invalid_type_xyz' });
    out.invalidType = bad.items
      ? { status: bad.status, items: bad.items.length }
      : { status: bad.status, body: JSON.stringify(bad.body).slice(0, 500) };
  } catch (e) { out.invalidType = { error: String(e && e.message || e) }; }

  // 2. Brute-force sleep eventType candidates.
  const candidates = [
    'sleep', 'Sleep', 'SLEEP', 'sleep_v2', 'sleepv2', 'sleepV2', 'sleep_summary', 'sleep_report',
    'sleep_record', 'sleep_records', 'sleep_daily', 'sleepDaily', 'watch_sleep', 'sleep_watch',
    'nap', 'day_nap', 'sleep_breathing', 'sleep_breath', 'sleep_breathing_quality', 'breath_sleep',
    'sleep_stage', 'sleep_stages', 'sleep_detail', 'night_sleep', 'restful_sleep', 'all_day_sleep',
    'daily_sleep', 'zeppos_sleep', 'sleep_score', 'total_sleep',
  ];
  out.hits = [];
  out.empty = [];
  for (const et of candidates) {
    try {
      const r = await q({ eventType: et });
      if (r.items && r.items.length) {
        out.hits.push({ eventType: et, count: r.items.length, sampleKeys: Object.keys(r.items[0]), sample: JSON.stringify(r.items[0]).slice(0, 500) });
      } else {
        out.empty.push(et + ':' + (r.items ? 0 : 'no-items(' + r.status + ')'));
      }
    } catch (e) { out.empty.push(et + ':err'); }
  }
  return out;
}

module.exports = async function handler(req, res) {
  // Never let a CDN/browser cache an API response (esp. a stale error).
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const email = process.env.ZEPP_EMAIL;
    const password = process.env.ZEPP_PASSWORD;
    if (!email || !password) {
      res.status(500).json({ ok: false, version: VERSION, error: 'Set ZEPP_EMAIL and ZEPP_PASSWORD in Vercel env vars.' });
      return;
    }

    const days = Math.min(parseInt((req.query && req.query.days) || '7', 10) || 7, 90);
    const debug = !!(req.query && req.query.debug);
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);

    const access = await getAccessToken(email, password);
    const auth = await loginWithToken(access);

    // Diagnostic: discover the Zepp OS sleep eventType. ?probe=1
    if (req.query && req.query.probe) {
      const probe = await probeEvents(auth, from.getTime(), to.getTime());
      res.status(200).json({ ok: true, version: VERSION, userId: auth.userId, range: [fmtDate(from), fmtDate(to)], probe });
      return;
    }

    const items = await fetchBandData(auth, fmtDate(from), fmtDate(to));

    const parsed = items.map(parseDay);
    const sleepRows = parsed.map(p => p.sleep).filter(Boolean);
    const dailyRows = parsed.map(p => p.daily).filter(Boolean);

    await upsert('zepp_sleep', sleepRows);
    await upsert('zepp_daily', dailyRows);

    const out = {
      ok: true,
      version: VERSION,
      range: [fmtDate(from), fmtDate(to)],
      daysReturned: items.length,
      sleepRows: sleepRows.length,
      dailyRows: dailyRows.length,
    };
    if (debug) out.raw = items;
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, version: VERSION, error: String(e && e.message || e) });
  }
};
