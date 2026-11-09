# Valy

Point a camera at almost any physical object (new or used, common or rare, modern or antique) and get a price range in seconds.

Valy identifies the item from a photo, finds real **sold** listings, and turns them into a calibrated interval with a confidence score, all inside a **7 second hard limit**.

> **The one rule:** language models read the photo and label evidence. **Plain, deterministic code makes every number.** A model never writes a price.

> Proprietary software, published for evaluation. All rights reserved (see `LICENSE`).

| | |
|---|---|
| **Client** | React 18, TypeScript, Vite, Tailwind (`src/`) |
| **Backend** | Supabase: Postgres + Edge Functions on Deno (`supabase/`) |
| **Models** | Claude Haiku 5.5 (photo reading, identification, listing labels) |
| **Data** | Serper for live sold listings |
| **Quality** | 700+ tests on Node's built-in runner, CI on every push |

## The pipeline at a glance

Entry point: `supabase/functions/value-item`.  Lines marked Haiku are model calls, lines marked code are pure and deterministic.

```
Photo ──► Protection (rate limits, before any paid call)
   │
   ▼
THREE EYES in parallel (0 to 1.5 s)  ·  Haiku
   Detail eye ········· logos, stamps, seams, condition ──► Judge, Memory
   Authenticity eye ··· fake signs, age, repairs, rarity ──► Judge, Market Live
   Identification ····· what it is, brand, country, wording
   │
   ├──► Judge-A (photo only, never sees ads)  ·  Haiku ─────► Judge
   ├──► Neighbour prior (similar past scans)  ·  code ──────► Math
   └──► Memory: seen this item before?  ·  database
          HIT ─────────────────────────────────────────────► Judge
          MISS
            ▼
   ┌─ MARKET LIVE ───────────────────────────────────────────────┐
   │ Search AI ──► Connector ──► Serper                          │
   │ picks up to    corrects the   sold listings per country,    │
   │ 4 searches     queries        stop at 5 sold or 2.0 s       │
   └───────────────────────────────┬─────────────────────────────┘
                                   ▼
   JUDGE  ·  Haiku
   gets: photo, Detail eye, Authenticity eye, the listings,
         Judge-A's labels.  Labels every listing, never a price
                                   ▼
   MATH  ·  code
   checks R1-R3 → second look → fusion of the labelled listings,
   Identification and neighbour prior → one interval → calibration
                                   ▼
   CHECK + FX  ·  code
   authenticity flag, plausibility, confidence, user's currency
                                   ▼
   Answer ≤ 7 s  ·  new valuations saved
```

Everything that reads evidence ends up at the **Judge**. The Judge's labels are the only thing that goes to the **Math**. Identification and the neighbour prior skip the Judge and meet the labelled listings inside the fusion.

## Walkthrough, step by step

**1. Protection** (`protection.ts`). Per device 20 counted valuations/hour and 60 attempts/hour, per network 500/hour, 1,500/day overall. It runs before any paid API call.

**2. Three eyes** (`eyes.ts`, `pipeline/stages/eyes.ts`). One photo, three focused reads, started at the same moment:
- **Detail eye:** what is physically visible (logos, stamps, seams, condition). Goes to Memory and the Judge.
- **Authenticity eye:** fake or replica signs, age from construction, repairs, rarity, original vs. later-made. Goes to the Judge, and can add one targeted "eye search" to Market Live.
- **Identification:** what the item is, type, brand, country, the search wording. If it cannot tell, the app asks for a better photo instead of guessing.

**3. Memory** (`memory.ts`). An identical item seen before is answered from storage. A near miss re-values the saved listings. Even a HIT still goes through the Judge, so Memory never skips the brain.

**4. Market Live** (`market-live.ts`). Finds the sold prices. Three parts working together:
- **Search AI** (`_shared/search-ai`): a learned planner that picks up to 4 searches most likely to surface sold prices, with fixed templates as fallback. Ported from a Python reference; golden files pin exact parity.
- **Connector** (`connector.ts`): corrects the search queries with three rule sets (R1 local name, RG global, RH Haiku's own search). Each rule runs on a share of traffic against an untreated control group, and keeps its share only if it does not hurt.
- **Serper:** sold listings per country, all searches in parallel. Stops at 5 sold prices or 2.0 s and cancels the rest. A thin market widens the hunt in steps (local, then regional, then global), with at most 7 searches in total.

**5. Judge and Judge-A** (`judge.ts`, `judge-a.ts`). Two Haiku calls with different jobs, and neither writes a price:
- **Judge** sees the evidence: the photo, the Detail and Authenticity eyes, the listings and Judge-A's labels. It labels every listing by *band*: same / similar / different, condition relative to the photo, authenticity risk.
- **Judge-A** sees only the photo and never the ads, so it is an independent opinion: a photo-only price band that goes to the Judge as labels.

**6. Math** (`math.ts`, `fusion.ts`, `fused-interval.ts`). Takes the Judge's labels (and nothing else from the Judge), checks them against the listings and Identification, and fuses listings, Identification and neighbour prior into one interval. See the next section.

**7. Check and currency** (`check.ts`, `money.ts`, `fx.ts`). Authenticity flag, plausibility, confidence score, then the amount in the user's currency.

**8. Answer in 7 s, hard cap.** Only new valuations are saved.

## The math

Everything numeric lives in `interval.config.ts`. All of it works on **ln(USD)** and is pure: no network, no randomness, no model text.

| Stage | Method |
|---|---|
| Band to number | Judge bands map to **fixed factors** in `ad-calibration.ts` (9 relative-value bands, 5 same-item bands). Models pick a band, code owns the number. |
| Cleaning | Same-item filter, then **median / MAD outlier removal**. |
| Per-ad evidence | Each ad gets a within-ad variance from its band (how likely is it the same item, how reliable is the ad). Asking prices are discounted to sold (x0.9). |
| Location | **Huber** robust location over the ads. |
| Spread between ads | **DerSimonian-Laird** tau-squared (random-effects meta-analysis), with an influence cap per ad. |
| Shared bias | A guard for the variant ambiguity that all ads share and that more ads cannot average away. |
| Independent sources | **Precision-weighted Bayesian fusion** of the labelled ads with independent sources: the Identification anchor, the neighbour prior and Judge-A's photo-only anchor (its price comes from code, from bands). A source is *tempered* when it contradicts the ads. |
| Interval | **Satterthwaite-style** degrees of freedom, **Student-t** quantiles: the central 80 % range (10th to 90th percentile). |
| Neighbour prior | **Recency-weighted median** (90-day half-life) of similar past scans, deliberately wide (sd floor 0.3), never allowed to overrule real ads. |
| No listings | **Estimate ladder**: Haiku supplies bounded facts (typical new price, age class, rarity), code turns them into a number via lookup tables, then neighbour prior, else "needs a better photo". |
| Second look | A 600 ms Haiku pass that may only *sharpen*, never override. |
| Calibration | **Split-conformal quantile** gives a width multiplier `k` per bucket so the 80 % range really holds about 8 of 10 real sale prices (target coverage 78 to 84 %). |

`backtest.ts` replays every stored **recipe** (the saved inputs of an interval) against real sale prices, scoring coverage, below/above balance, median absolute ln error and pinball loss.

## The learning loop

Three nightly GitHub Actions call Edge Functions that read the logs and write small policy tables. All of it shrinks toward conservative priors and moves slowly.

| Job | Writes | Method |
|---|---|---|
| `search-ai-nightly-ts` | `l_search_policy` | **Thompson sampling** (Gamma posteriors), 14-day half-life, hold-out days, minimum sample sizes |
| `nightly-connector` | `l_connector_policy`, `l_connector_weights` | Treated vs. control scored with a **one-sided Welch test**, **Bonferroni** corrected per night. A dial only moves down when a rule is shown to hurt, by a bounded step. |
| `nightly-calibrate` | `l_calibration`, `l_ad_calibration` | **Conformal** width fit per bucket with **shrinkage toward the parent bucket** and an evidence-scaled step limit. Judge band tables fitted by **scaled MAD**, shrunk and bounded so band order can never invert. |

Learning logs hold item fingerprints only: no photos, user ids or IP addresses. Photos are never stored. Plan usage is counted separately in `l_usage`.

## Fallbacks

Every failure has a defined, tested answer, so the user never sees an error screen.

| Failure | Answer |
|---|---|
| Search AI slow or down | Fixed search templates |
| No Serper key or no time | `market_skipped`, estimate |
| Judge too slow | Saved answer (Memory) or a fallback judgement from ad prices |
| No comparable listings | Estimate ladder, otherwise ask for a better photo |
| Identification fails | Continues without Memory and Judge-A |

## Plans and status

Defined once in `src/lib/plans.ts` (UI) and `value-item/plan-limits.ts` (enforcement). A blocked request runs no pipeline stage.

| Plan | Scans | SEK/month incl. VAT |
|---|---|---|
| Free | 20 in total | 0 |
| Pro | 300 / month | 99 |
| Premium | 1,000 / month | 199 |
| Business | 5,000 / month | 749 |

Payments run through Stripe (`create-checkout`, `stripe-webhook`, `customer-portal`). Server-side limits are behind `PLAN_LIMITS_ENABLED` and the client daily counter behind `DAILY_LIMIT_ENABLED`, both **off** until launch. Apple/Google sign-in needs provider setup in Supabase; email sign-in works as is.

## Repository layout

```
src/                         React client (camera, result card, history, plans); tests in src/lib/tests
supabase/functions/
  value-item/                The pipeline and its tests
    pipeline.ts, pipeline/   Orchestration (run.ts) and pure stages
    connector.ts, connector/ The Connector: model, rules R1/RG/RH, invariants
  _shared/                   Shared pure maths: Search AI, Connector learner, calibration fits
  connector-learn/, calibrate/   Nightly learners
  explain-item/              "How we valued it" paragraph and dead-link check
  create-checkout/, stripe-webhook/, customer-portal/   Subscriptions
supabase/migrations/         Schema, row-level security, learned-policy tables
scripts/                     nightly caller, measure-brain.mjs, check-countries.mjs
```

## Run it

Requires Node 22+.

```bash
npm install
cp .env.example .env.local      # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

`npm test` (backend and client logic, no extra dependencies) · `npm run typecheck` · `npm run lint` · `npm run build`

## Deploy

```bash
supabase db push
supabase functions deploy value-item connector-learn calibrate explain-item create-checkout customer-portal plan-prices
supabase functions deploy stripe-webhook --no-verify-jwt   # Stripe has no Supabase JWT (also set in supabase/config.toml)
supabase secrets set ANTHROPIC_API_KEY=... SERPER_API_KEY=...
# Payments: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_{PRO,PREMIUM,BUSINESS}_{MONTH,YEAR}
```

Frontend (Vercel or similar): set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` before the build. In Supabase turn on Authentication > "Allow anonymous sign-ins" and add the site URL under Redirect URLs.

Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as GitHub Actions secrets (the nightly jobs skip themselves until they exist) for the nightly jobs. Optional tuning secrets are listed at the top of `value-item/index.ts`.

## Design principles

- **Code decides prices, models label evidence.** Model output is bounded, validated and never trusted as a number.
- **Every fallback is explicit** and tested.
- **Learning is measured, not assumed.** Priors, slow steps, control groups.
- **Pure core, thin edges.** Network, clock and randomness are injected, so tests are fast and deterministic.

## Glossary

| Term | Meaning |
|---|---|
| **Brain** | The valuation pipeline in `value-item` |
| **Eyes** | Photo reads: Detail eye, Authenticity eye, Identification |
| **Judge / Judge-A** | Labels listings (Judge) or the photo alone (Judge-A) by band |
| **Recipe** | The stored inputs of an interval, replayable in backtests and calibration |
| **Bucket** | A country / category / plan-source group that calibration is fitted per |
