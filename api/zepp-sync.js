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
// This uses the UNOFFICIAL Huami API (same approach as
// bentasker/zepp_to_influxdb and Gadgetbridge). It can break if
// Huami changes their endpoints; the raw payload is stored in the
// `raw` column so history can always be re-parsed.
// =============================================================
'use strict';

// Same Supabase project as sync.js/topbar.js (publishable key is
// already public in the repo; RLS intentionally disabled).
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cvkbfrqobqgdoiamjrqu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_yPebAeVX7FXMo2rtf7HqGg_DNFKUjIp';

const REDIRECT_URI = 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html';

function fmtDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// ---- Step 1: email+password -> short-lived access code ----
async function getAccessCode(email, password) {
  const res = await fetch(
    'https://api-user.huami.com/registrations/' + encodeURIComponent(email) + '/tokens',
    {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        state: 'REDIRECTION',
        client_id: 'HuaMi',
        password: password,
        redirect_uri: REDIRECT_URI,
        token: 'access',
      }),
    }
  );
  const location = res.headers.get('location') || '';
  const access = new URL(location, REDIRECT_URI).searchParams.get('access');
  if (!access) {
    throw new Error('Zepp login step 1 failed (status ' + res.status +
      ', location: ' + location.slice(0, 200) + '). Check ZEPP_EMAIL/ZEPP_PASSWORD.');
  }
  return access;
}

// ---- Step 2: access code -> app_token + user_id ----
async function loginWithCode(access) {
  const res = await fetch('https://account.huami.com/v2/client/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      app_name: 'com.xiaomi.hm.health',
      app_version: '6.3.5',
      code: access,
      country_code: 'FR',
      device_id: '02:00:00:00:00:00',
      device_model: 'android_phone',
      grant_type: 'access_token',
      allow_registration: 'false',
      dn: 'account.huami.com,api-user.huami.com,api-mifit.huami.com',
      source: 'com.xiaomi.hm.health:6.3.5',
      third_name: 'huami',
    }),
  });
  const data = await res.json().catch(() => ({}));
  const info = data && data.token_info;
  if (!info || !info.app_token || !info.user_id) {
    throw new Error('Zepp login step 2 failed: ' + JSON.stringify(data).slice(0, 300));
  }
  return { appToken: info.app_token, userId: info.user_id };
}

// ---- Step 3: fetch daily band summaries ----
async function fetchBandData(auth, fromDate, toDate) {
  // -de2 is the EU cluster; fall back to the global host if it 4xx/5xxes.
  const hosts = ['https://api-mifit-de2.huami.com', 'https://api-mifit.huami.com'];
  let lastErr = null;
  for (const host of hosts) {
    const url = host + '/v1/data/band_data.json?' + new URLSearchParams({
      query_type: 'summary',
      device_type: 'android_phone',
      userid: auth.userId,
      from_date: fromDate,
      to_date: toDate,
    });
    const res = await fetch(url, { headers: { apptoken: auth.appToken } });
    if (res.ok) {
      const body = await res.json();
      if (body && Array.isArray(body.data)) return body.data;
      lastErr = new Error('Unexpected band_data body: ' + JSON.stringify(body).slice(0, 300));
    } else {
      lastErr = new Error('band_data ' + res.status + ' on ' + host);
    }
  }
  throw lastErr;
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
  if (slp && slp.st && slp.ed) {
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

module.exports = async function handler(req, res) {
  try {
    const email = process.env.ZEPP_EMAIL;
    const password = process.env.ZEPP_PASSWORD;
    if (!email || !password) {
      res.status(500).json({ ok: false, error: 'Set ZEPP_EMAIL and ZEPP_PASSWORD in Vercel env vars.' });
      return;
    }

    const days = Math.min(parseInt((req.query && req.query.days) || '7', 10) || 7, 90);
    const debug = !!(req.query && req.query.debug);
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);

    const access = await getAccessCode(email, password);
    const auth = await loginWithCode(access);
    const items = await fetchBandData(auth, fmtDate(from), fmtDate(to));

    const parsed = items.map(parseDay);
    const sleepRows = parsed.map(p => p.sleep).filter(Boolean);
    const dailyRows = parsed.map(p => p.daily).filter(Boolean);

    await upsert('zepp_sleep', sleepRows);
    await upsert('zepp_daily', dailyRows);

    const out = {
      ok: true,
      range: [fmtDate(from), fmtDate(to)],
      daysReturned: items.length,
      sleepRows: sleepRows.length,
      dailyRows: dailyRows.length,
    };
    if (debug) out.raw = items;
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
