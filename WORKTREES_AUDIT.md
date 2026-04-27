# JEM ASR App — Documentation & Worktree Migration Plan

_Generated 2026-04-27 from working tree at `E:\jem-asr-app`._

**Main HEAD:** `f9cc487 feat(asr): per-call Vertex prompt + version compare diff (#22)`. The commit `7aa49fd feat(training): on-demand training export from table UI` lives on `feat/web-training-export` (1 commit ahead of main, **unmerged**) — it is a Phase-2 candidate.

---

## 1. App at a Glance

**Purpose:** Browser-based workbench that converts thousands of raw Yiddish recordings (Lubavitcher Rebbe's talks 1950–1992 + Satmar + new training audio) into clean, timestamped, audio-text training pairs for fine-tuning a Yiddish ASR model. The 50-hour curated set is the immediate training target; 5 "benchmark" files are locked out of training.

**Stack:** Vite + vanilla JS ESM (no frameworks) → Cloudflare Pages, Cloudflare Pages Functions ("Workers") for proxies, Supabase (Postgres + Auth + RLS) for data and auth, Cloudflare R2 for audio + transcript blobs, RunPod GPUs for stable-ts / Whisper alignment, Vertex AI for fine-tuned Gemini ASR, Mendel API for ivrit-ai ASR.

**Live URL:** `https://jem-asr-app.pages.dev` — manual deploy (`npm run build && npx wrangler pages deploy dist/ --project-name jem-asr-app`).

---

## 2. High-Level Architecture

```
Browser (Vite/ESM)
  index.html  (table)
  detail.html (per-file workbench)
  transcribe.html (ASR scratchpad)
  admin.html  (libraries + members + uploads)
  login.html / dashboard.html
        │
        ▼
Cloudflare Pages
  /api/align           → RunPod stable-ts/Whisper aligner (handles base64 + R2 fetch + trim)
  /api/audio           → R2 streaming proxy (1d cache, SSRF allowlist via ALLOWED_R2_DOMAINS)
  /api/transcript      → R2 transcript text proxy
  /api/transcribe      → Gemini Vertex / Mendel ASR proxy (POST) + health (GET on ui-revamp)
  /api/asr             → ASR provider routing
  /api/upload, /api/upload-url, /api/migrate-audio  → R2 uploads
  /api/training-export → on-demand training export (feat/web-training-export — not yet on main)
  /api/invite          → Supabase Auth admin (create/invite users + library_members)
  /api/whatsapp, /api/stripe-webhook  → adjacent product surfaces
  /api/desktop/*       → desktop client endpoints
        │
        ├─ Supabase (project `xqivwkksimsvxsxhnzsj`)
        │     audio_files / transcripts / mappings / alignments / reviews
        │     transcript_edits (versioned: cleaned, edited, asr-gemini/whisper/mendel, custom-*)
        │     segment_approvals / activity_log / asr_models / benchmark_results
        │     libraries / library_members (multi-tenant)
        │     api_keys / whatsapp_billing
        │
        ├─ R2 buckets (jem-asr-audio @ audio.kohnai.ai + pub-c3d984…r2.dev)
        │
        └─ RunPod
              align.kohnai.ai (stable-ts iterative aligner)
              ivrit-iterative-aligner pod
              stable-ts-aligner pod (pre-trim audio in pod)
              ivrit-ai trainer worker (PR #17)
```

---

## 3. Repo Layout (top-level)

```
jem-asr-app/
├── index.html / detail.html / transcribe.html / admin.html / login.html / dashboard.html
├── style.css                     (~88KB, light theme, RTL, mobile-first)
├── vite.config.js                (6 entry points; add new top-level pages here)
├── wrangler.toml                 (Cloudflare Pages project + R2 binding)
├── package.json                  ({"@supabase/supabase-js","vite"})
├── .env                          (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
├── CLAUDE.md                     (~1035 lines — operational bible; READ BEFORE TOUCHING)
├── src/
│   ├── app.js                    Entry: load catalog, init state, wire toolbars
│   ├── state.js                  In-memory store; transcriptVersions chain; localStorage + Supabase sync
│   ├── db.js                     Supabase client; loadFromSupabase, syncStateKey, lazy loaders, splitTranscript, search
│   ├── auth.js                   Supabase auth + multi-tenant library context
│   ├── login.js / admin.js       Login + admin dashboard logic
│   ├── table.js                  Audio table — filters, sort, pagination, bulk select, inline play, card view
│   ├── transcript-table.js       Transcripts tab
│   ├── mapping.js                Date+keyword scoring; suggested matches; search modal; global text search
│   ├── cleaning.js               10 cleaning passes; clean rate; batch clean
│   ├── alignment.js              RunPod /api/align client; chunking; retries; surrogate strip; trim handoff
│   ├── review.js                 Diff viewer + inline edit + approve/reject
│   ├── benchmark.js              ASR config + WER/CER calculator + comparison table
│   ├── transcribe.js             Standalone ASR transcription page logic
│   ├── detail.js                 Per-file workbench (~140KB — pipeline stepper, word view, karaoke, ASR, splits)
│   ├── split.js                  Split-from-here logic
│   └── utils.js                  parseHebrewDate, normalizeYiddish, levenshtein, WER/CER, SRT/VTT, debounce
├── functions/api/                Cloudflare Pages Functions (see arch diagram)
├── runpod/
│   ├── ivrit-iterative-aligner/  Iterative aligner Docker image
│   └── stable-ts-aligner/        Trim-aware stable-ts image
├── supabase/migrations/          19 migrations
├── scripts/                      seed-transcripts, measure-audio-duration, backfill-type
├── public/                       static (legacy data.json no longer loaded)
├── dates/                        Hebrew date parsing helpers
└── .github/, .claude/, .wrangler/
```

---

## 4. Data Model (Supabase)

| Table | PK | Purpose |
|---|---|---|
| `audio_files` | `id` | Catalog of every audio file. `is_selected_50hr`, `is_benchmark`, `library_id`, `r2_link`, `duration_minutes`, `comments`, `name_history`, `type` |
| `transcripts` | `id` | Catalog of transcripts. `text` (lazy-loaded), `first_line`, `r2_transcript_link`, `name_history`, `library_id` |
| `mappings` | `audio_id` | Audio↔transcript link with `confidence`, `match_reason`, `confirmed_by`, `created_at` |
| `alignments` | `audio_id` | Word timestamps + per-word confidence (`words` lazy-loaded) |
| `reviews` | `audio_id` | Approval status + `edited_text` |
| `transcript_edits` | (audio_id, version) | Versioned text. `version` ∈ `{cleaned, edited, asr-gemini, asr-whisper, asr-mendel, custom-*}` |
| `segment_approvals` | (audio_id, segment_hash) | Persistent per-segment approval — survives re-alignment when text unchanged |
| `asr_models`, `benchmark_results` | id | Configs + WER/CER runs |
| `activity_log` | bigserial | Audit trail of user actions |
| `libraries`, `library_members` | id | Multi-tenancy + RLS scoping |
| `api_keys`, `whatsapp_billing*` | … | Adjacent products sharing infra |

**Views:** `latest_edits`, `audio_pipeline_status`.

**Critical rules:** RLS forces `library_id IN user_library_ids()`. Every sync helper passes `library_id`. `ensureAudioFile` uses `ignoreDuplicates: true` (FK guard only). `fetchAll()` paginates 1000-row chunks; never use `.limit(10000)`.

---

## 5. Pipeline & State

**Status state machine** (`getStatus()` in state.js):
```
unmapped → mapped → cleaned → aligned → approved
                                   ↘ rejected → mapped (re-clean)
```

**Primary store:** `state.transcriptVersions[audioId]` = chain of `{id, type, text?, alignment?, review?, model?, createdAt, …}`. Types: `manual | cleaned | edited | asr | custom`. Best-version priority: `edited > cleaned > asr > manual`.

**Legacy mirrors:** `mappings`, `cleaning`, `alignments`, `reviews` flat objects, kept in sync via `syncLegacyKeys`.

**Persistence:** `updateState()` writes localStorage instantly, fire-and-forgets `syncStateKey()` to Supabase. `mergeSupabaseData(remote)` REPLACES (not merges) authoritative keys on startup.

**Iteration:** every version has `iteration: number`. Re-cleaning after alignment bumps the iteration.

---

## 6. Key Subsystems

- **Mapping** — Hebrew date parsing + content-type keyword scoring with firstLine bonuses. Suggested matches → search modal → global full-text Supabase ilike search.
- **Cleaning** — 10 deterministic regex passes. Diff modal with character-level LCS strikethrough. Auto-saves `edited` version.
- **Alignment** — Browser sends `audio_url` to `/api/align`; Worker fetches R2, trims server-side, base64-encodes, forwards to RunPod. Auto-chunks at 15K chars. 15× retry × 10s for cold-start (~2.5min). Lone-surrogate strip. Trim params via `trim_start/trim_end/audio_duration`.
- **Word view** — `contenteditable` editor with inline `[M:SS]` anchors + read-only karaoke sidebar. Auto-save debounced 800ms. Speed bar (0.5–2×). Problem segment filter (3+ consecutive low-conf words).
- **ASR** — three providers (Gemini Vertex / Whisper / Mendel). Each model has its own version slot (`asr-<model>`). Worker secrets only.
- **Benchmark** — 5 locked gold files; UI hides Approve; never enters export. WER + CER.
- **Training export** — on-demand from table UI (feat/web-training-export, plus the merged groundwork in PR #21).
- **Multi-tenancy** — every table has `library_id`; auth.js resolves active library; localStorage keys `asr-state-${libraryId}`.
- **Auth** — Supabase email+password; invite supports temp password OR email magic link; recovery via `resetPasswordForEmail`. RLS requires `authenticated` role.

---

## 7. Worktree Inventory (post-Phase-1)

`git worktree list` after cleanup:

```
E:/jem-asr-app                                        f9cc487 [main]
E:/jem-asr-app/.claude/worktrees/modest-moser-edaf86  b6bb1c7 [claude/modest-moser-edaf86]
E:/jem-asr-app/.claude/worktrees/ui-revamp            d9e425f [feat/ui-ux-revamp]
```

**Local branches kept:**

| Branch | Purpose |
|---|---|
| `main` | current |
| `feat/ui-ux-revamp` | Phase 6 (worktree present) |
| `claude/modest-moser-edaf86` | Phase 7 (worktree present) |
| `fix/audit-2026-04-20` | Phase 3 |
| `fix/critical-api-auth` | Phase 3-related (auth gating on /api/asr and /api/transcribe) |
| `fix-align-allowed-domains-default` | Phase 2 |
| `claude/nice-hodgkin-2591c3` | Phase 2 |
| `feat/web-training-export` | Phase 2 (carries `7aa49fd`) |
| `SplitTranscriptRecordFeature` | Phase 5 canonical |
| `claude/admiring-engelbart-20584c` | Phase 5 (subset of split feature) |
| `claude/friendly-mendeleev-205f29` | Phase 5 (split tail-text fix) |
| `claude/blissful-agnesi-838265` | Phase 5 (split trim_end cap) |
| `remove-cleaned-version` | Phase 8 review (likely abandon) |

**Remote branches still ahead of main:** `origin/fix/audit-2026-04-20` (15), `origin/fix/code-review-2026-04` (5), `origin/fix/stability-cleanups-v2` (1), `origin/SplitTranscriptRecordFeature` (3), `origin/claude/general-session-admZx` (1), `origin/claude/analyze-database-structure-h1oz7` (2), `origin/claude/code-review-audit-VtVGN` (1, audit report), `origin/simplified` (1).

**Removed in Phase 1 (worktrees):** `wiggly-toasting-hellman`, `adoring-elbakyan-7340e0`, `gallant-ritchie-c483aa`, `compassionate-carson-086f37`, `curious-hopper-a1b2c3`, `determined-khorana-1f4431`, `pedantic-dhawan-9013ca`.

**Removed in Phase 1 (local branches, 16):** `fix-alignment-issue`, `claude/adoring-elbakyan-7340e0`, `claude/compassionate-carson-086f37`, `claude/gallant-ritchie-c483aa`, `claude/happy-turing-a17771`, `claude/pedantic-dhawan-9013ca`, `claude/vibrant-banzai-c39584`, `droid/curious-hopper-a1b2c3`, `feat/vertex-prompt-and-compare`, `worktree-wiggly-toasting-hellman`, `claude/intelligent-moser-fe6709`, `claude/jolly-poincare-f908dc`, `claude/nifty-snyder-740d94`, `claude/peaceful-hodgkin-16cd30`, `fix-edit-save-issue`, `GeminiTuning`.

**Backups in `_worktree-rescue/`** (gitignored):
- `docker-pack/pack/` — Dockerfile + pack-entrypoint.sh from determined-khorana
- `compassionate-carson-diff/uncommitted.patch` — 8.8MB diff of file deletions

---

## 8. Migration Plan — Phases

### Phase 0 — Snapshot (current)
1. Tag main: `git tag -a pre-merge-audit-2026-04-27 main && git push origin pre-merge-audit-2026-04-27`.
2. Commit `.gitignore` + `WORKTREES_AUDIT.md` to main.

### Phase 1 — Garbage collect (DONE)
7 worktrees removed, 16 obsolete local branches deleted, primary checkout moved to `main`.

### Phase 2 — Fast-forward easy fixes (one PR per branch)
1. `origin/fix/stability-cleanups-v2` (`d8e35d5`) — saveToStorage after migrations + conservative day parsing.
2. `fix-align-allowed-domains-default` (`5312e10`) — r2.dev hostname env fallback.
3. `origin/claude/general-session-admZx` (`e98ee25`) — persist `transcribeProviders` + 50hr rejected count + DRY.
4. `claude/nice-hodgkin-2591c3` (`dbd47df`) — auto-create placeholder transcript.
5. `feat/web-training-export` (`7aa49fd`) — on-demand training export from table UI.

### Phase 3 — Land the security audit
Merge `origin/fix/audit-2026-04-20` (15 commits) as a single PR. Resolve conflicts in detail.js / transcribe.js / align.js / asr.js / state.js / login.js / db.js / review.js. Coordinate with `fix-align-allowed-domains-default` for SSRF allowlist. Also evaluate `fix/critical-api-auth` separately if not subsumed.

### Phase 4 — Land the code-review/perf set
Merge `origin/fix/code-review-2026-04` (5 commits) on top of post-audit main.

### Phase 5 — Decide on Split feature
Pick `SplitTranscriptRecordFeature` (3 commits, superset). Cherry-pick `99ec0db` from `claude/blissful-agnesi-838265` if not in superset. Drop `claude/admiring-engelbart-20584c` and `claude/friendly-mendeleev-205f29` (subsets).

### Phase 6 — UI/UX revamp (`feat/ui-ux-revamp`)
Slice into 3 PRs along its commits: foundation, table redesign + Vertex test + state fixes, Manual compare + a11y.

### Phase 7 — Transcript picker unification (`claude/modest-moser-edaf86`)
Apply migration first. Rebase on post-Phase-6 main. Reconcile detail.js conflicts with refresh.css selectors. Smoke-test ASR + custom slots + insights.

### Phase 8 — Optional candidates
- `origin/simplified` — multi-tenant leaks fix.
- `origin/remove-cleaned-version` — likely abandon.
- `origin/claude/analyze-database-structure-h1oz7` — adopt SQL changes if novel.
- `origin/claude/code-review-audit-VtVGN` — informational.

### Phase 9 — Cleanup
1. Delete merged remote branches.
2. `git remote prune origin`, `git fetch --prune`, `git worktree prune`.
3. Update CLAUDE.md if Phases 6/7 changed behavior.
4. Tag final main.

---

## 9. Risks

- `feat/ui-ux-revamp` and `claude/modest-moser-edaf86` both touch `src/detail.js` heavily — order matters; rebasing the second is painful.
- `fix/audit-2026-04-20` may break `r2.dev` flow if `ALLOWED_R2_DOMAINS` Pages secret isn't updated alongside.
- Migration `20260422000000_transcript_comments_and_custom.sql` (modest-moser) requires Supabase deploy ahead of code merge.
- Several branches share commits via cherry-picks — always verify with `git log main..<branch>`.

---

## 10. TL;DR

- **Main is at `f9cc487`** (PR #22 merged); `7aa49fd` is on `feat/web-training-export` and **not** yet on main.
- Phase 1 cleanup complete: 7 worktrees + 16 branches removed.
- 3 worktrees remaining: `main`, `feat/ui-ux-revamp` (Phase 6), `claude/modest-moser-edaf86` (Phase 7).
- 12 candidate branches remain; merge order is **GC → easy fixes (Phase 2, 5 PRs) → audit (Phase 3) → code-review (Phase 4) → split (Phase 5) → ui-revamp sliced (Phase 6) → modest-moser (Phase 7) → optional (Phase 8) → cleanup (Phase 9)**.
