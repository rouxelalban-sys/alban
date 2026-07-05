# JARVIS — Life Dashboard roadmap

Personal operating system: static HTML pages + `sync.js` (localStorage ↔ Supabase
`app_state`) + Vercel serverless functions in `api/` for anything needing secrets.
Art direction: **JARVIS sci-fi HUD** — deep-space navy base with starfield, glowing
cyan for everything active/achieved, red-orange alerts (`jarvis.css`; pages also
inline the tokens so they can't render unstyled). Hardware: **Amazfit Helio Strap**
via the Zepp app.

## Phases

| # | Phase | Contents | Status |
|---|---|---|---|
| 1 | Foundation + JARVIS design | `supabase-setup.sql` (all tables + pgvector), `jarvis.css`, `api/` skeleton, index rework with System Output gauge | ✅ done |
| 2 | Zepp + Energy | `api/zepp-sync.js` (unofficial Zepp v2 encrypted API, daily Vercel cron), `sleep.html` (hypnogram, regularity, sleep debt), Rise-style circadian Energy Flow on index, System Output sleep component (once data flows) | ✅ done — first real sync 2026-07-05 pulled 31 nights; account works on the US (us2) cluster |
| 3 | Mood | `mood.html` — How We Feel: 4 quadrants × 36 emotions (144 FR words + definitions), 3-step check-in, calendar heatmap, distribution, recent, sleep×mood correlation, lazy weather (open-meteo), auto-attached Zepp sleep, PWA (manifest/sw/icon) + best-effort reminders | ✅ code done — reminders are foreground-only until a push server (later); verify on device |
| 4 | Nutrition | `food.html` — MyFitnessPal-style macros, `api/food-vision.js` (Claude vision estimates macros from a plate photo), text quick-add, food library, OpenFoodFacts barcodes, weight log | ⬜ |
| 5 | Sport | `climb.html` (sessions, sends, grade pyramid, projects) + extend `gym.html` (est. 1RM charts, weekly volume, PRs, recovery-modulated suggestions from HRV/sleep) | ⬜ |
| 6 | Second brain 1+2 | obsidian-git → private GitHub repo, `api/obsidian.js`, `brain.html` (browse/search/render notes), quick capture → vault, nightly auto daily-note with real data | ⬜ |
| 7 | Second brain 3 + Mentor | `api/embed.js` → pgvector, `mentor.html` with Nova-style 3D crystal avatar (Three.js, expressions driven by real data), `api/mentor.js` (profile + aggregates + RAG over vault + long-term memories) | ⬜ |
| 8 | Synthesis | Cross-correlations (sleep×mood×sport×food), weekly AI review written into the Obsidian vault | ⬜ |

## Key decisions

- **Zepp**: no official API → unofficial Huami cloud API (login `api-user.huami.com`,
  data `api-mifit.huami.com` `band_data`), same approach as bentasker/zepp_to_influxdb.
  Fallbacks if it breaks: Google Fit bridge, GDPR export.
- **Security**: RLS/auth intentionally skipped (single user, owner's choice). Secrets
  still live in Vercel env vars because Zepp/Claude/GitHub calls can't run in the browser.
- **System Output score**: composite 0–100 of the day's inputs. Phase 1: goals 40% /
  stack 30% / water 30% (weights redistribute when a category is empty). Sleep, mood
  and macros join the formula as their phases land. States: <40 Standby, <70 Online,
  <100 Optimal, 100 Full Power.
- **Inspirations**: Rowan V2-YT (this repo's base + gym), his Whoop integration pattern
  (→ Helio Strap), liamwiseeEEEee/mentor "Nova" (avatar), How We Feel (mood), Rise
  (circadian energy), MyFitnessPal (macros), JARVIS/Iron Man HUD (design — was
  Limitless/NZT gold in the very first pass, changed on Alban's request 2026-07-05).
