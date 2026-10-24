# CRO Score Agent (Vercel app)

Scores one page for conversion readiness with Claude, shows the logic behind the score, and states its limits. Built from the CRO Score Agent Instruction Guide v1.0.

## Deploy on Vercel
1. Import this repo in Vercel (framework: Next.js, no config needed).
2. Add environment variables (Project Settings > Environment Variables):
   - `ANTHROPIC_API_KEY` (required). Create at https://console.anthropic.com > API Keys. Used server-side only for the judgement step; it never reaches the browser.
   - `PAGESPEED_API_KEY` (optional). Google Cloud Console > enable "PageSpeed Insights API" > Credentials. Enables Core Web Vitals (pillar 7). Without it, pillar 7 is "Could not test" and excluded.
   - `CRO_MODEL` (optional, default `claude-sonnet-5-5`).
3. Deploy. The audit route allows up to 60 s (`maxDuration`), which needs a plan that supports it.

## Run locally
```
cp .env.example .env.local   # fill in the key
npm install
npm run dev
npm test
```

## How it works
- `lib/inspect.ts` fetches the page (SSRF-guarded, robots.txt respected) and measures facts with cheerio. On Shopify product pages it also reads the store's public `/products/<handle>.json`.
- `lib/audit.ts` sends facts and page text, tagged as untrusted, to Claude, which must return quotes copied from the page. Code verifies every quote; unverifiable ones become hypotheses and cannot lower the score.
- `lib/scoring.ts` computes score, coverage, confidence and priority. The model never does arithmetic.
- `lib/rubric.json` holds the versioned pillars, anchors, weights and thresholds.

## Limitations
Static HTML only (no tap-target, contrast or screenshot checks, no JavaScript-rendered content). No visitor behaviour in a public audit: pillar 8 is excluded and lowers confidence. Public audits cap at Medium confidence. Weights are uncalibrated proposals. The rate limiter is per serverless instance, best effort.
