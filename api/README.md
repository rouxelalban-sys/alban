# api/ — Vercel serverless functions

Everything that needs a secret lives here (the browser pages never hold keys).
Each file becomes an endpoint at `/api/<name>` when deployed on Vercel.

Planned functions (see PLAN.md for phases):

| File | Phase | Purpose | Env vars |
|---|---|---|---|
| `zepp-sync.js` | 2 | Daily cron — pull sleep/steps/HR/HRV from the Zepp (Huami) cloud into Supabase | `ZEPP_EMAIL`, `ZEPP_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |
| `food-vision.js` | 4 | Estimate macros from a meal photo or text via Claude vision | `ANTHROPIC_API_KEY` |
| `obsidian.js` | 6 | Read/write the Obsidian vault mirrored to a private GitHub repo | `GITHUB_TOKEN`, `VAULT_REPO` |
| `embed.js` | 7 | Chunk + embed vault notes into `brain_chunks` (pgvector) | `VOYAGE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |
| `mentor.js` | 7 | Mentor chat — profile + fresh aggregates + RAG over the vault | `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |

Set the env vars in Vercel → Project → Settings → Environment Variables.
