# JEM Yiddish ASR Workbench

> **What is this?** A browser-based tool that turns thousands of raw Yiddish audio recordings into clean, labeled training data for an AI speech recognition model — with no backend server required.

---

## The Big Picture

JEM (Jewish Educational Media) has thousands of recordings of the Lubavitcher Rebbe's talks (1950–1992). Most have never been transcribed. The goal: train an AI that can automatically transcribe Yiddish speech, then use it to make the entire archive searchable.

To train that AI, we need **50 hours of verified audio-text pairs**. This app is the workbench that produces them.

---

## The User Journey

Every audio file moves through a pipeline from raw → ready. Here's the full flow:

```mermaid
flowchart TD
    A([🎙️ 4,669 Audio Files\nRaw archive]) --> B

    B{Has a\ntranscript?}
    B -- No --> C[1️⃣ MAPPING\nFind & link the right transcript\nusing date + keyword matching]
    B -- Yes --> D

    C --> D[2️⃣ CLEANING\nStrip editorial notes, brackets,\nsection headers — keep only\nthe Rebbe's spoken words]

    D --> E[3️⃣ ALIGNMENT\nSend audio + text to GPU.\nGet back word-by-word timestamps\nand confidence scores.]

    E --> F[4️⃣ REVIEW\nHuman checks the work.\nRed words = low confidence = look here.\nEdit inline, then approve.]

    F --> G{Approved?}
    G -- Yes --> H([✅ Training Data\nClean audio-text pairs\nwith timestamps])
    G -- No --> D

    H --> I[5️⃣ KARAOKE\nPlay audio with words\nhighlighting in sync.\nExport as SRT/VTT subtitles.]

    J([🏆 5 Gold Standard Files\nPerfect reference transcripts]) --> K[6️⃣ BENCHMARK\nRun ASR models on gold files.\nMeasure accuracy before & after training.\nThese NEVER enter the training set.]

    H --> L[7️⃣ TRANSCRIPTION\nUse the trained model to\nauto-transcribe the remaining\n2,860 untranscribed files.]
```

---

## Component Map

How the pieces connect:

```mermaid
graph LR
    subgraph Browser["🌐 Browser (your computer)"]
        UI[index.html\nThe single page]
        APP[app.js\nWires everything together]
        STATE[state.js\nAll data lives here\nlocalStorage + Supabase]
        DB[db.js\nSupabase client\nsync + load]
        TABLE[table.js\nThe main table view]
        MAP[mapping.js\nMatch audio ↔ transcript]
        CLEAN[cleaning.js\nStrip editorial noise]
        REV[review.js\nHuman verification panel]
        KAR[karaoke.js\nAudio player + word sync]
        BENCH[benchmark.js\nWER/CER scoring]
        UTIL[utils.js\nShared helpers]
    end

    subgraph CF["☁️ Cloudflare (the cloud)"]
        PAGES[Cloudflare Pages\nHosts the app]
        W1[/api/align\nProxy Worker]
        W2[/api/audio\nProxy Worker]
        W3[/api/transcript\nProxy Worker]
        R2[(R2 Bucket\naudio.kohnai.ai\nAudio + transcript files)]
    end

    subgraph SB["🗄️ Supabase (JEM-ASR-Workbench)"]
        SBDB[(PostgreSQL\nxqivwkksimsvxsxhnzsj\nmappings, alignments,\nreviews, transcript_edits,\naudio_files, transcripts)]
    end

    subgraph GPU["⚡ GPU Server"]
        RUNPOD[align.kohnai.ai\nRunPod endpoint\nYiddish-tuned Whisper]
    end

    UI --> APP
    APP --> STATE
    APP --> DB
    STATE --> DB
    APP --> TABLE
    APP --> MAP
    APP --> CLEAN
    APP --> REV
    APP --> KAR
    APP --> BENCH
    STATE --> UTIL
    MAP --> UTIL
    BENCH --> UTIL

    Browser --> CF
    DB --> SB
    W1 --> RUNPOD
    W2 --> R2
    W3 --> R2
```

---

## What Each Mode Does

### 1. Mapping — *"Which transcript goes with this recording?"*
The archive has 4,669 audio files and 1,065 transcripts. They weren't linked. The app compares Hebrew dates and content type in filenames to suggest matches — ranked by confidence. The reviewer clicks to confirm or uses the search modal to find manually.

Matching score (0–1.0):
- Exact year+month+day match → 1.0
- Year+month match → 0.5
- Year only → 0.25
- Content type keyword in both filenames → +0.15
- Transcript has firstLine text stored → +0.05 (prefers transcripts with richer metadata)
- firstLine contains matching content type keyword → +0.05

### 2. Cleaning — *"Strip the editor's notes, keep only the spoken words"*
Transcripts were prepared by human editors who added notes, section headers, and markers. Five regex passes remove all of that:
- `[brackets]` → removed
- `(parenthetical notes)` → removed
- Section markers like `סעיף א׳` and `* * *` → removed
- Zero-width characters, smart quotes → normalized
- Extra whitespace and blank lines → collapsed

**Clean Rate** = what percentage of words survived. Below 50% means something looks wrong.

Note: "cleaned" is a pipeline status on an **audio file** — it means the transcript text linked to that audio has been cleaned and is ready for alignment. The cleaned text is stored in `transcript_edits` keyed by `audio_id`.

### 3. Alignment — *"Match each word to its exact timestamp in the audio"*
The cleaned text and audio are sent to a GPU server (RunPod) running a Yiddish-tuned Whisper model. It returns every word with a start time, end time, and confidence score. **Important:** The GPU scales to zero when idle — the first call can take ~2.5 minutes to warm up. The app retries automatically.

### 4. Review — *"A human checks the work"*
The review panel shows:
- A diff: original transcript vs. cleaned transcript (removed text in red)
- Every word as a colored chip — 🟢 green (confident), 🟠 orange (uncertain), 🔴 red (check this)
- Inline editing: click any word to fix it
- Approve / Reject / Skip buttons

### 5. Karaoke — *"Listen and watch the words highlight"*
An audio player where words light up as they're spoken. Used to verify alignment quality during review, and to export subtitle files (SRT/VTT) for video players.

### 6. Benchmark — *"Is the AI actually getting better?"*
Five gold-standard files with verified-perfect transcripts are used to measure model accuracy. The app runs them through any configured ASR model and calculates WER (Word Error Rate) and CER (Character Error Rate). **These files are permanently locked out of the training set.**

### 7. Transcription — *"Auto-transcribe the rest of the archive"*
Once the model is trained and benchmark scores look good, this mode sends the remaining 2,860 untranscribed audio files to the fine-tuned model for automatic transcription. The results go through the same review → karaoke → approve pipeline.

---

## The Status Pipeline (one file's journey)

```mermaid
stateDiagram-v2
    [*] --> unmapped : File loaded from Supabase
    unmapped --> mapped : User links a transcript
    mapped --> cleaned : Transcript text cleaning pass runs
    cleaned --> aligned : GPU alignment completes
    aligned --> approved : Human approves in review
    aligned --> mapped : Human rejects → re-clean
    approved --> [*] : Exported to training set

    note right of aligned
        Words colored by confidence
        guide the reviewer's eye
    end note

    note right of approved
        Benchmark files stop here —
        they never enter the training set
    end note
```

---

## Data & Storage

### Where data lives

| What | Where | Notes |
|------|-------|-------|
| Audio metadata (4,669 files) | Supabase `audio_files` | **Primary source** — loaded at startup |
| Transcript metadata (1,065 files) | Supabase `transcripts` | **Primary source** — loaded at startup |
| Full transcript text (50hr set) | Supabase `transcripts.text` | 227/228 50hr transcripts have full text stored |
| User work (mappings, cleaning, alignment, reviews) | Supabase + `localStorage` | Supabase is primary; localStorage is offline cache |
| Audio files | Cloudflare R2 (`audio.kohnai.ai`) | Proxied via `/api/audio` |
| Original transcript files | Cloudflare R2 (`audio.kohnai.ai/transcripts-txt/`) | Proxied via `/api/transcript` |

`public/data.json` is still present in the repo (used by the seed script) but the **app no longer loads it** — Supabase is the single source of truth for the catalog.

### Supabase database (JEM-ASR-Workbench)
- **Project ref:** `xqivwkksimsvxsxhnzsj`
- **URL:** `https://xqivwkksimsvxsxhnzsj.supabase.co`
- **RLS:** All tables have `public_read_write` policy (anon key has full access)

#### Tables

| Table | PK | Contents |
|-------|-----|---------|
| `audio_files` | `id` | All 4,669 audio files. Key columns: `is_selected_50hr`, `is_benchmark`, `r2_link`, `duration_minutes`, `comments`, `name_history` (JSONB rename trail) |
| `transcripts` | `id` | All 1,065 transcripts. Key columns: `first_line`, `r2_transcript_link`, `text` (full text for 50hr), `name_history` (JSONB rename trail) |
| `mappings` | `audio_id` | Audio → transcript links. Columns: `transcript_id`, `confidence`, `match_reason`, `confirmed_by`, `created_at` |
| `alignments` | `audio_id` | Word timestamps + confidence scores |
| `reviews` | `audio_id` | Approval status + `edited_text` (user's corrected text) + `reviewed_at` |
| `transcript_edits` | `(audio_id, version)` | Cleaned transcript text. `version` is TEXT (e.g. `'cleaned'`). Columns: `text`, `original_text`, `clean_rate`, `created_at`, `created_by` |
| `asr_models` | `id` | ASR model configurations |
| `benchmark_results` | `id` | WER/CER benchmark run results |

#### Views

| View | Purpose |
|------|---------|
| `latest_edits` | Most recent edit per audio file |
| `audio_pipeline_status` | Each audio with `pipeline_status` (unmapped/mapped/cleaned/aligned/approved), `is_selected_50hr`, `is_benchmark`, `transcript_name`, `mapping_confidence` — use this in Supabase dashboard to monitor progress |

#### Name history tracking
Both `audio_files` and `transcripts` have a `name_history JSONB` column. A `BEFORE UPDATE` trigger automatically appends `{name, changed_at}` whenever a row's name changes, preserving the full rename trail.

#### 50hr collection flags
- `audio_files.is_selected_50hr = true` → 200 files, ~49.97 hours — equal distribution across all 40 years (5711–5752), ~75–80 min per year. Trimmed from original 420 files.
- `audio_files.is_benchmark = true` → 5 files (gold standard, never in training)

- **FK constraint:** `mappings`, `alignments`, `reviews`, `transcript_edits` all have FK → `audio_files.id`. `db.js` upserts the audio file row first before writing related rows (`ensureAudioFile()`).

### Startup flow (Supabase-only)
Both `app.js` (main table) and `detail.js` (per-file detail page) use the same Supabase startup flow:

1. Shows "Loading…" spinner
2. `loadFromSupabase()` fetches all tables in parallel — returns full `audio[]`, `transcripts[]` arrays plus work data (mappings, cleaning, alignments, reviews)
3. `initState({ audio, transcripts })` initializes state (also loads localStorage cache for offline work)
4. `mergeSupabaseData(remote)` overwrites localStorage cache with authoritative Supabase work data
5. `audioNames` localStorage overrides applied to `state.audio` entries so renamed files show correct names immediately
6. Page renders

**Every change:** `updateState()` saves to localStorage instantly, then calls `syncStateKey()` fire-and-forget to upsert the changed row in Supabase.

### Exporting your work
- **Export State** button → downloads a JSON file of all your work (mappings, cleaning, alignments, reviews)
- **Export CSV** button → downloads only the approved rows, ready for training
- Work is cloud-synced — moving computers just means opening the app

---

## The 5 Benchmark Files (locked forever)

These files have verified-perfect transcripts and are used only for measuring model quality:

```
0015--5711-Tamuz 12 Sicha 1.mp3
0142--5715-Tamuz 13d Sicha 3.mp3
2781--5741-Nissan 11e Mamar.mp3
0003--5711-Shvat 10c Mamar.mp3
2925--5742-Kislev 19 Sicha 1.mp3
```

The app enforces: no "Approve" button on these rows, never included in training exports, always shown with a purple "Benchmark" badge. `is_benchmark=true` and `is_selected_50hr=false` in Supabase.

---

## Keyboard Shortcuts

| Key | What it does |
|-----|-------------|
| `↑` / `↓` | Move between rows |
| `Enter` | Approve the current row |
| `S` | Skip (decide later) |
| `R` | Reject (needs re-cleaning) |
| `E` | Toggle word edit mode |
| `Space` | Play / pause audio |
| `←` / `→` | Seek audio ±5 seconds |
| `/` | Jump to search box |
| `Escape` | Close any modal |
| `Ctrl+A` | Select all visible rows |
| `Ctrl+E` | Export state as JSON |
| `Ctrl+Shift+E` | Export approved rows as CSV |

---

## Success Looks Like

1. All 200 pairs in the 50-hour set: mapped → cleaned → aligned → reviewed → approved
2. Zero benchmark files in the training export
3. WER score drops after fine-tuning (e.g., Whisper baseline 45% → fine-tuned 18%)
4. The remaining 2,860 audio files transcribed automatically
5. Subtitle files generated for video playback

---

---
---

# Technical Reference (for developers)

---


## Known Gotchas

### Startup lazy loading — transcript text and alignment words NOT fetched at startup
`loadFromSupabase()` intentionally omits heavy fields:
- `transcripts` fetched without `text` column — full text loaded on demand in the detail page
- `alignments` fetched without `words` column — word array loaded on demand in the detail page

`loadAlignmentWords(audioId)` and `loadTranscriptText(transcriptId)` in `db.js` are the lazy loaders. `detail.js` calls these when opening a file. `cleaning.js` `batchClean()` calls `loadTranscriptText` as fallback when R2 fetch fails.

**Do not add `text` or `words` back to the startup queries** — it would fetch megabytes for 4,669 files on every page load.

### Supabase row limit — use fetchAll(), not .limit()
`supabase.from(...).select(...).limit(10000)` does NOT work — Supabase's server-side `max_rows` caps responses at 1,000 rows regardless of the client-side `.limit()` call. All startup queries use `fetchAll(table, columns)` defined in `db.js`, which paginates in 1,000-row chunks via `.range(from, from+999)` until all records are returned. Never replace this with `.limit()`.

### Page layout: body is a flex column, table scrolls internally
`body` uses `display: flex; flex-direction: column; height: 100%`. The `.table-container` has `flex: 1; overflow: auto; min-height: 0` so it fills the remaining viewport height and scrolls internally. The `<thead>` is `position: sticky; top: 0` within that scroll container. The app header and filter bar are always visible above the table — they do not need `position: sticky`. Do not revert to a scrolling-page layout or the sticky column header will appear in the wrong position.

### Cloudflare Pages — manual deploy required
The Pages project is NOT connected to GitHub auto-deploy. Every release requires:
```bash
npm run build
npx wrangler pages deploy dist/ --project-name jem-asr-app
```

### DB column: `duration_minutes` not `est_minutes`
Renamed via migration `20260323000000_rename_est_minutes.sql`. All app code uses `duration_minutes`.

### Real audio duration auto-corrects via detail page
`audio_files.duration_minutes` was originally seeded from estimated values. When a detail page loads, the audio player's `loadedmetadata` event fires and gives the real duration. `detail.js` compares it against `audio.estMinutes` — if different, it calls `syncAudioDuration(audioId, realMin)` in `db.js` to update `audio_files.duration_minutes` in Supabase. The table Duration column self-corrects for any file once its detail page has been visited.

### DB column: `comments` on `audio_files`
Added via migration `20260323000001_add_audio_comments.sql`. Editable inline in the table; syncs to Supabase on blur via `updateState('audioComments', id, value)` → `syncAudioComment()`.

### Audio name edits sync to Supabase
Editing a name in the table calls `updateState('audioNames', id, newName)` → `syncStateKey` → `UPDATE audio_files SET name = ? WHERE id = ?`. The `name_history` trigger on `audio_files` automatically records the old name. `state.audio[n].name` is also updated in memory so filters/search reflect the change immediately.

### Manual transcript tab is read-only
In `detail.js`, versions with `type === 'manual'` render the textarea with `readOnly = true` — no save handlers are attached, and a 🔒 badge is shown. A **"Start Editing"** button appears below the read-only area; clicking it fetches the full text (R2 → Supabase fallback), creates an `edited` version via `addVersion()`, and re-renders the detail page with that version active. This means every mapped file can immediately start editing without running cleaning tools first.

### Cleaning pass buttons are async
`getCurrentText()` in `detail.js` is async — it fetches the full transcript text from R2 or Supabase if no cleaning data exists yet (startup optimization means `transcript.text` is null). Pass buttons show "Loading…" while fetching, then open the diff preview. Always `await getCurrentText()` before running a pass.

### wordDiffTokens emits both removed and added tokens
`wordDiffTokens(origLine, cleanLine)` returns tokens of three kinds: `{ text, isSpace }` (unchanged), `{ text, removed: true }` (struck-through red), and `{ text, added: true }` (green replacement). When a word is removed, the function peeks at the next clean word — if it doesn't appear later in orig, it's treated as a replacement and emitted as `added`. CSS: `.diff-word-added { background: rgba(74,222,128,0.15); color: var(--green); }`. All three token-rendering sites in `detail.js` must handle `tok.added`.

### Rejected diff rows have visual feedback
`.diff-row-rejected` class sets `opacity: 0.38` and strikes through child text. Applied by checkbox `change` handler and the "Reject All" button. "Accept All" removes it from all rows.

### Karaoke inline word editing
In `detail.js` `renderWordView()`, an **"Edit Words"** toggle button switches between play mode and edit mode:
- Edit mode: clicking a chip opens an inline `<input>`; Tab advances to next word; Enter/Escape commits/cancels
- A bulk RTL textarea shows all words space-joined; "Apply Text to Words" maps back by position (warns on count mismatch)
- "Save Word Edits" calls `updateState('alignments', audioId, { ...alignment, words: editModeWords })`
- Seek-click handlers are stored as `chip._seekHandler` and disabled/restored on mode toggle

### Mobile card view opens detail page
At ≤480px the table switches to card view (`buildCardView` in `table.js`). Each card has an **"Open"** button and the card itself is clickable — both navigate to `detail.html?id=<audioId>` in a new tab. The old inline-expand behavior is removed.

### Row click behavior by status
Clicking a table row calls `onRowExpand(audioId)` in `app.js`, which dispatches based on status:
- `unmapped` → expands inline to show mapping suggestions + Search Transcripts button
- `mapped` / `cleaned` → navigates directly to `detail.html?id=` in a new tab (no inline panel)
- `aligned` / `approved` → expands inline to show the review panel + Karaoke button
- `benchmark` → expands inline to show benchmark tools

The inline mapping bar (Linked to / Unlink / Change Transcript / Split Transcript) has been removed from all expanded panels — those controls are on the detail page.

### Audio name inline editing stops propagation on the input
In `table.js` `case 'name'`, clicking the `nameSpan` replaces it with an `<input>` and calls `e.stopPropagation()`. The `<input>` itself also has a click handler calling `e.stopPropagation()` — without this, clicking inside the input to reposition the cursor would bubble to the `<tr>` click handler and trigger row navigation.

### Cleaning passes and alignment use the selected version tab's text
`renderDetailPage` creates a shared `activeVersionRef = { id }` object and passes it to both `renderMappingSection` and `renderUnifiedWorkSection`. Whenever the user clicks a version tab, `activeVersionRef.id` is updated. `getCurrentText()` in `renderUnifiedWorkSection` reads from the selected version's `.text` for non-manual versions, or falls back to loading the raw transcript from R2/Supabase for the manual version. The alignment button calls `getCurrentText()` and passes the result as `textOverride` to `alignRow(audioId, state, textOverride)` — so alignment always runs on whatever version is currently displayed.

### Manual version text is always loaded from the transcript, never from a stale cache
In `renderVersionContent`, `type === 'manual'` versions skip the `version.text` check entirely and always load from `transcript.text` (or R2/Supabase if not yet in memory), caching on the `transcript` object rather than the `version` object. This ensures the Manual tab always matches "View Transcript Independently" (`detail?tid=`). Non-manual versions (`cleaned`, `edited`, etc.) still use `version.text` as before.

## Build Rules
- Vite + vanilla JS ESM. No frameworks.
- Named exports only. No default exports.
- Modules import only from `src/utils.js`, `src/state.js`, and `src/db.js` as shared deps.
- `.env` holds `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — baked in at build time by Vite.

## File Structure

```
jem-asr-app/
├── index.html                  # Single page shell
├── detail.html                 # Per-file detail page
├── style.css                   # Dark theme, RTL, responsive
├── .env                        # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (build-time)
├── src/
│   ├── app.js                  # Entry: load catalog from Supabase, init state, wire everything
│   ├── state.js                # State management, localStorage + Supabase sync
│   ├── db.js                   # Supabase client, loadFromSupabase(), syncStateKey()
│   ├── table.js                # Unified table: filters, sort, pagination, bulk select
│   ├── mapping.js              # Matching algorithm, suggested matches, search modal
│   ├── cleaning.js             # 5-pass regex cleaner, clean rate, batch clean
│   ├── alignment.js            # RunPod API calls, confidence parsing, batch align
│   ├── review.js               # Diff viewer, inline editing, approve/reject
│   ├── karaoke.js              # Audio player, word highlighting, SRT/VTT export
│   ├── benchmark.js            # ASR API config, WER/CER calculator, comparison table
│   ├── detail.js               # Per-file detail page logic
│   └── utils.js                # parseHebrewDate, normalizeYiddish, levenshtein, CSV
├── functions/api/
│   ├── align.js                # CF Worker: POST proxy → align.kohnai.ai/api/align
│   ├── audio.js                # CF Worker: GET proxy for R2 audio (streams, 1-day cache)
│   └── transcript.js           # CF Worker: GET proxy for transcript text from R2
├── scripts/
│   ├── seed-transcripts.mjs    # One-off: seed all transcripts + fetch 50hr text from R2
│   └── measure-audio-duration.mjs  # One-off: measure real MP3 duration, update est_minutes
├── supabase/migrations/        # All schema changes tracked here
├── public/data.json            # Legacy catalog (~246KB) — used only by seed scripts, NOT by app
├── wrangler.toml
└── package.json
```

## State Architecture

### Primary store: `transcriptVersions`

Each audio file has a chain of transcript versions:

```javascript
state.transcriptVersions["a_001"] = [
  { id, type: "manual",  sourceTranscriptId, confidence, matchReason, createdAt },
  { id, type: "cleaned", text, originalText, cleanRate, createdAt },
  { id, type: "asr",     text, model, createdAt },
  // Any version can also carry:
  //   .alignment = { words, avgConfidence, lowConfidenceCount, alignedAt }
  //   .review    = { status, editedText, reviewedAt }
]
```

Version priority (getBestVersion): `edited > cleaned > asr > manual`

### Legacy keys (auto-synced)

`syncLegacyKeys(audioId)` keeps these flat objects in sync from `transcriptVersions`:
`state.mappings`, `state.cleaning`, `state.alignments`, `state.reviews`

Direct writes via `updateState()` still work. Legacy keys exist for simpler reads.

### getStatus state machine

```javascript
versions.some(v => v.review?.status === 'approved')  → 'approved'
versions.some(v => v.review?.status === 'rejected')  → 'rejected'
versions.some(v => v.alignment)                       → 'aligned'
versions.some(v => v.type === 'cleaned')              → 'cleaned'
versions.length > 0                                   → 'mapped'
else                                                  → 'unmapped'
```

Falls back to legacy keys if `transcriptVersions` is empty.

## Module Exports

### state.js
```javascript
initState(data), getState(), updateState(key, audioId, value)
getStatus(audioId), getVersions(audioId), getVersionsByType(audioId, type)
getBestVersion(audioId), addVersion(audioId, data), updateVersion(audioId, versionId, updates)
getFilteredRows(filter, searchTerm, sortCol, sortDir, yearFilter, monthFilter, typeFilter)
getFilterCounts()         // returns counts for all filter pill keys
mergeSupabaseData(remote) // merge Supabase work data (mappings/cleaning/alignments/reviews) into state
exportState(), importState(json)
```

### db.js
```javascript
// PRIMARY: returns { audio[], transcripts[], mappings, alignments, reviews, cleaning }
// audio[] and transcripts[] are full catalog arrays sorted by numeric ID.
loadFromSupabase()

syncStateKey(key, audioId, value, audioEntry)  // dispatch upsert for the changed key
// Handled keys: 'audioNames' → audio_files.name, 'audioComments' → audio_files.comments,
//               'mappings', 'cleaning', 'alignments', 'reviews'
syncMapping(audioId, mapping, audioEntry)
syncCleaning(audioId, cleaningData, audioEntry)
syncAlignment(audioId, alignmentData, audioEntry)
syncReview(audioId, reviewData, audioEntry)
deleteMapping(audioId)

// Bulk seed helpers (used by scripts, not the app itself)
bulkSyncAudioFiles(audioArray)
bulkSyncTranscripts(transcriptArray)
bulkSyncMappings(mappingsObj)   // ignoreDuplicates — won't overwrite user-confirmed
```

`ensureAudioFile(audio)` is called internally before any write that has a FK → `audio_files.id`.

**Actual DB column names** (important — these differ from the camelCase app fields):
- `mappings.created_at` (not `confirmed_at` — that column doesn't exist)
- `reviews.edited_text` (added via migration)
- `transcript_edits.version` is TEXT (was mistakenly INTEGER at creation; fixed via migration)
- `transcript_edits.text` (added via migration — stores the cleaned text content)

### mapping.js
```javascript
getSuggestedMatches(audioItem, allTranscripts, existingMappings)  // → [{transcriptId, score, matchReason, firstName}]
renderSuggestedMatches(container, audioId, state, onLink)          // container is FIRST param
linkMatch(audioId, transcriptId, confidence, reason)
unlinkMatch(audioId)   // also calls deleteMapping() to persist deletion in Supabase
renderSearchModal(container, state, onSelect)
```

Scoring includes `firstLine` bonus: +0.05 if transcript has firstLine, +0.05 more if firstLine contains content-type keyword matching the audio filename.

### cleaning.js
```javascript
cleanBrackets(text), cleanParentheses(text), cleanSectionMarkers(text)
cleanSymbols(text), cleanWhitespace(text)
cleanText(raw)        // all 5 passes in sequence
cleanRate(raw, cleaned)   // = calculateCleanRate (both exported, equivalent)
batchClean(audioIds, state)
```

### review.js
```javascript
renderReviewPanel(container, audioId, state, callbacks)  // container is FIRST param
approveAll(selectedIds, state)
setupKeyboardNav(callbacks)
```

Confidence chip classes: `.confidence-high` (≥0.8), `.confidence-mid` (≥0.4), `.confidence-low` (<0.4)

### alignment.js
```javascript
alignRow(audioId, state)              // retries 3× on 502/504 with 10s delay
batchAlign(audioIds, state, onProgress)
transcribeAudio(audioId, audioUrl, modelConfig)
```

Request to `/api/align`:
```json
// Untrimmed R2 audio — URL passed directly (avoids 413 Cloudflare body-size limit):
{ "mode": "align", "audio_url": "https://audio.kohnai.ai/training/...", "text": "...", "language": "yi" }

// Trimmed audio or non-R2 sources — base64 WAV downsampled to 16 kHz mono:
{ "mode": "align", "audio_base64": "...", "audio_format": ".wav", "text": "...", "language": "yi" }
```

**GPU server must support `audio_url`** — when present, the server fetches the audio from that URL itself. The R2 bucket is publicly accessible so no auth is needed. `audio_base64` still works for trimmed/non-R2 audio.

Response parsing: `data.timestamps[]` first, fallback to `data.segments[].words[]`. Confidence field: `confidence → probability → score`.

### Alignment 413 Payload Too Large
Cloudflare Pages rejects request bodies over ~25 MB. A 20-minute MP3 at 128 kbps base64-encodes to ~25 MB — longer files will 413. Fix: for untrimmed R2 audio, `alignment.js` sends `audio_url` instead of fetching and encoding the file. For trimmed audio, the crop is downsampled to 16 kHz mono WAV (~6× smaller than stereo 44.1 kHz) before encoding. The GPU server at `align.kohnai.ai` must accept `audio_url` and fetch the audio itself.

### karaoke.js
```javascript
renderKaraokePlayer(audioId, state)   // appends modal to document.body
downloadFile(content, filename, mimeType)
```

### benchmark.js
```javascript
renderAsrConfig(container, state)
runBenchmark(benchmarkAudioIds, state, onProgress)
renderBenchmarkTable(container, state)
```

API keys (`asrModels[].apiKey`) are **never exported** in state JSON.

### utils.js
```javascript
parseHebrewDate(filename)           // → { year, month, day }
normalizeYiddish(text)              // strip nikkud U+0591-U+05C7, punct, lowercase
levenshtein(refWords, hypWords)     // → { distance, operations: [{type:'S'|'I'|'D', ref, hyp}] }
calculateWER(reference, hypothesis) // → { wer, cer, substitutions, insertions, deletions, total }
generateSRT(words)                  // group on gap>0.5s or every ~10 words
generateVTT(words)
exportCSV(rows, columns)            // triggers download
truncateWords(text, n)
formatConfidence(score)             // 0.85 → "85%", null → "—" (em dash)
debounce(fn, ms)
```

## Filter Keys

Both formats work: `'fifty'` = `'50hr'`, `'fifty-unmapped'` = `'50hr-unmapped'`, etc.

The `'fifty'` view shows all 200 `is_selected_50hr` files — no type filtering is applied.

Valid keys: `fifty`, `fifty-unmapped`, `fifty-mapped`, `fifty-cleaned`, `fifty-aligned`, `fifty-approved`, `all`, `unmapped`, `mapped`, `cleaned`, `benchmark`, `needs-review`, `approved`

## R2 URL Patterns

```
Benchmark audio:  https://audio.kohnai.ai/benchmark/<filename>
Training audio:   https://audio.kohnai.ai/training/<filename>
Transcript text:  https://audio.kohnai.ai/transcripts-txt/<filename>.txt

App proxies all R2 audio via:  /api/audio?url=<encoded-r2-url>
App proxies transcripts via:   /api/transcript?name=<filename>
App proxies alignment via:     /api/align  (POST)
```

## Visual Design

```css
--bg:             #0a0a0f   /* page background */
--surface:        #16162a   /* cards, panels */
--text:           #e8e8f0   /* primary text */
--text-secondary: #8888aa   /* muted */
--accent:         #00d4ff   /* links, active */
--green:          #4ade80   /* high confidence, approved */
--orange:         #fb923c   /* medium confidence */
--red:            #f87171   /* low confidence, rejected */
--purple:         #b366ff   /* benchmark */
```

RTL: `.hebrew-text { direction: rtl; text-align: right; unicode-bidi: embed; }`

Responsive breakpoints: 1200px (full) / 768px (compact) / 480px (card view)

## WER Formula

```
WER         = (S + I + D) / N      (N = reference word count)
CER         = (S + I + D) / C      (at character level)
Custom WER  = (I + D + critical_S) / N

Normalization before comparison:
  Strip nikkud U+0591–U+05C7 → strip punctuation → lowercase Latin → collapse whitespace
```

## Deploy

```bash
npm run build
npx wrangler pages deploy dist/ --project-name jem-asr-app
```

Live: `https://jem-asr-app.pages.dev`
