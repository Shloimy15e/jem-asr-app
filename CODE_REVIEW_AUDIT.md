# Code Review Audit — JEM ASR Workbench

**Date:** 2026-03-24
**Scope:** Full codebase review — bugs, redundancy, duplication, and bad logic
**Method:** Reviewed CLAUDE.md spec first, then audited every source file against it

---

## Critical Bugs (Will cause user-visible problems)

### 1. `app.js:77-82` — Aligned/approved rows navigate instead of showing inline review panel

**Spec says:** `aligned`/`approved` rows should expand inline to show the review panel + "Open Detail Page" button.
**Code does:** All non-unmapped, non-benchmark statuses navigate to `detail.html` in a new tab.

```javascript
if (status === 'mapped' || status === 'cleaned' || status === 'aligned' || status === 'approved') {
  window.open(`/detail.html?id=${encodeURIComponent(audioId)}`, '_blank');
  return;
}
```

**Impact:** The `renderReviewPanel` import is completely unused. Review keyboard shortcuts (S, R, E, Enter-to-approve) are non-functional from the main table. The documented inline review workflow doesn't exist.

### 2. `cleaning.js:11-12` — `cleanParentheses` keeps content instead of removing it

**Spec says:** `(parenthetical notes)` → removed.
**Code does:** Regex captures and *keeps* the text inside parentheses using `$1`.

**Impact:** Parenthetical editorial notes survive the cleaning pass, polluting alignment input.

### 3. `cleaning.js:59` — `cleanQuestionMarks` removes ALL question marks

**Spec says:** "Question mark artifacts (multiple ???) → collapsed."
**Code does:** Removes every `?` character, including single legitimate question marks.

**Impact:** Valid punctuation is destroyed.

### 4. `cleaning.js:63-64` — `cleanEllipsis` misses Unicode ellipsis character (U+2026)

**Spec says:** "Ellipsis patterns (... and …) → removed."
**Code does:** Regex `\.{2,}` only matches 2+ literal dots, not the Unicode `…` character.

### 5. `review.js:210-219` — Approve button shown for benchmark files in review panel

**Spec says:** "no Approve button on benchmark rows."
**Code does:** `renderReviewPanel` always renders the Approve button. Only `approveAll` (line 253) skips benchmarks. Individual approval is unguarded.

**Impact:** A user could accidentally approve a benchmark file via the review panel, corrupting it into the training set.

### 6. `detail.js` — Event listener leaks on every re-render

Multiple event listeners are added to `playerEl` without cleanup:
- `play`/`pause` listeners in `renderWordView` (line 1336-1337) — accumulate on each re-render
- `loadedmetadata`/`timeupdate`/`play`/`pause`/`ended` in `renderTrimControls` (lines 2218-2245)
- Compare view `timeupdate` listeners orphaned when parent re-renders (lines 1132-1151)

**Impact:** Performance degrades progressively as users interact with the detail page.

### 7. `state.js:339 vs 438` — Filter pill count doesn't match displayed rows for "mapped"

`getFilteredRows('mapped')` shows mapped + cleaned + aligned rows (3 statuses), but `getFilterCounts()` only counts exact `mapped` status. The pill shows "10" but 18 rows appear.

### 8. `mapping.js:140-165` — `unlinkMatch` bypasses state management entirely

Directly mutates `state.mappings` and `state.transcriptVersions` with `delete`, then manually serializes to localStorage. Doesn't trigger Supabase sync for the deletion, doesn't clean up `state.cleaning`, `state.alignments`, or `state.reviews`. If `state.js` adds new keys, this manual persist silently drops them.

---

## Significant Logic Issues

### 9. `state.js:101-104` — `mergeSupabaseData` doesn't truly replace on undefined

```javascript
if (remote.mappings)   state.mappings = remote.mappings;
```

If `loadFromSupabase()` returns `undefined` for a key (e.g., fetch error), old stale localStorage data persists. Should use `state.mappings = remote.mappings ?? {};`.

### 10. `state.js:105` — `trims` uses merge instead of replacement

```javascript
if (remote.trims) Object.assign(state.trims, remote.trims);
```

Every other work key is replaced entirely, but `trims` is merged. Deleted trims persist in localStorage forever.

### 11. `mapping.js:57` — Score cap at 1.0 defeats tiebreaker bonuses

Exact date match = 1.0. Adding keyword (+0.15) and firstLine bonuses (+0.05, +0.05) yields 1.25, clamped to 1.0. The bonuses that are supposed to break ties among same-date matches are useless.

### 12. `review.js:247-259` — `approveAll` doesn't verify alignment exists

Skips benchmark files but doesn't check if each file actually has alignment data. Can approve unmapped/unaligned files, corrupting pipeline state.

### 13. `alignment.js:216` — Zero `audioDuration` breaks chunk proportioning

If `trimEnd` is 0 and `audioDuration` is 0 (null `estMinutes`), `effectiveEnd = 0`. All proportional calculations produce 0, sending `trim_start: 0, trim_end: 0` for every chunk.

### 14. `align.js:69-77` (Worker) — Byte-proportional MP3 trimming is inaccurate

Assumes bytes are linearly proportional to time. Wrong for VBR MP3. More critically, slicing MP3 at arbitrary byte offsets produces invalid frames — the decoder will misinterpret data at the splice point.

### 15. `align.js:71` — `audio_duration` defaults to 1 when missing

`const totalDuration = payload.audio_duration || 1;` — if `audio_duration` is 0 or missing while trim params exist, `startByte = 60 * totalBytes` could exceed the buffer, producing empty audio.

### 16. `utils.js:12-18` — Hebrew month matching: Adar vs Adar I/II

Months are checked in order. "Adar" (index 7) matches before "Adar I" (index 8) and "Adar II" (index 9). A filename containing "Adar II" matches plain "Adar" first, losing the I/II distinction.

### 17. `state.js:43` — `confirmedAt` field name mismatch with DB

`migrateToVersions` reads `mapping.confirmedAt` but DB column is `created_at`. If `loadFromSupabase` returns `createdAt`, the migration reads `confirmedAt` as `undefined` and substitutes `new Date().toISOString()`, losing the original timestamp.

### 18. `detail.js:971-986` — Race condition in lazy-loaded alignment words

If user triggers re-render while alignment words are loading, the `.then()` callback runs after the new render, appending a duplicate word view to the already-replaced container.

---

## Redundancy & Duplication

### 19. `table.js:227-372` — `openRemapModal` duplicates `mapping.js:renderSearchModal`

145-line implementation in `table.js` that duplicates the search modal from `mapping.js`. Both show suggested matches, let users search transcripts, and call `linkMatch`. Any fix must be mirrored in both.

### 20. `cleaning.js:67-76` — `cleanSymbols` internally re-calls 4 other cleaning functions

`cleanSymbols` calls `cleanSurroundingQuotes`, `cleanHyphens`, `cleanQuestionMarks`, `cleanEllipsis`. These are also exported individually. Running individual passes then `cleanText` (which calls `cleanSymbols`) runs those 4 passes twice. The 9-pass architecture is hidden behind this nesting.

### 21. `detail.js` — 12 identical `renderDetailPage` re-render calls

Every action callback ends with:
```javascript
const s = getState();
renderDetailPage(audioId, s.audio.find(a => a.id === audioId), s, pageContainer);
```
Repeated 12 times. Should be a helper.

### 22. `detail.js` — `fmtSec` (line 1509) and `formatTime` (line 2031) do the same thing

Both format seconds into `m:ss`. Only differ in null handling (`'?'` vs `'0:00'`).

### 23. `detail.js:533-561` — Change Transcript and Unlink cleanup logic duplicated

Nearly identical 8-line blocks that clear versions, cleaning, alignments, and reviews. Should be a shared helper.

### 24. `state.js:317-333` — Fifty-filter status patterns repeated 5 times

`fifty.filter(a => getStatus(a.id) === '<status>')` copy-pasted for each status. Should be data-driven.

### 25. `state.js` + `table.js` — Double filtering/sorting architecture

`getFilteredRows` in state.js supports search, sort, year, month, type params. But `updateTable` calls it with only the filter key, then applies its own `matchesSearch` and `sortRows`. Duplicated logic across modules.

### 26. `cleaning.js:108-126` — Transcript text fetching duplicated from `detail.js:loadFullText`

R2-fetch-then-Supabase-fallback pattern implemented independently in both modules.

### 27. `utils.js:201-218` — `exportCSV` duplicates `downloadFile` blob/download logic

`exportCSV` contains its own blob creation and download trigger that could call the existing `downloadFile` helper.

---

## Security Concerns

### 28. All three Workers have `Access-Control-Allow-Origin: *`

No auth check on the Workers themselves. Any website can call `/api/align` (GPU costs money), `/api/audio`, or `/api/transcript`. Should restrict to `jem-asr-app.pages.dev` or check a session token.

### 29. `functions/api/transcript.js:23` — No hostname validation on constructed URL

Unlike `align.js` (which validates `audio.kohnai.ai`), the transcript proxy concatenates the `name` param directly into the R2 URL. While `encodeURIComponent` prevents simple path traversal, it's inconsistent with the defense-in-depth approach of the other workers.

---

## Data Integrity Issues

### 30. `state.js:480-518` — `importState` doesn't call `migrateToVersions`

Unlike `mergeSupabaseData`, `importState` doesn't migrate legacy keys into `transcriptVersions`. Imported files with legacy-only data leave versions and legacy keys out of sync.

### 31. `state.js:456-478` — `exportState` omits `audioNames`

Audio renames are lost on export/import cycle.

### 32. `detail.js:535-539` — Unlink/Change Transcript doesn't delete Supabase rows

Sets local state to null but leaves orphaned rows in Supabase. On next load, `mergeSupabaseData` restores the old data.

### 33. `db.js` — No retry logic on any sync operation

All sync functions are one-shot fire-and-forget. Transient network failures silently drop changes from the server. Only localStorage acts as a cache.

### 34. `db.js:326` — `fetchAll` returns partial data silently on pagination error

If page 3 of 5 fails, ~2000 of 4669 rows are returned with no warning. The app shows a partial catalog.

### 35. `benchmark.js:173` — Benchmark results accumulate infinitely with no dedup

`results.push(result)` appends every run. Running benchmarks multiple times produces duplicate entries. The render hides duplicates via `byModel` grouping, but storage grows unbounded.

---

## Performance Issues

### 36. `db.js:353` — `transcript_edits` fetches ALL columns at startup

Violates the lazy-loading principle. Fetches full `text` and `original_text` for every cleaned/edited file — potentially megabytes. Should fetch a column list excluding text, with lazy loading on the detail page.

### 37. `table.js:575-576` — O(n²) audio lookup in `buildTable`

`state.audio.find(a => a.id === row.id)` is called for every displayed row inside `buildTable`. With PAGE_SIZE=50 and 4669 audio entries: 233K comparisons per render.

### 38. `state.js:145,154` — `state.audio.find()` called twice in `updateState`

Same linear scan over 4669 items done twice on every state update.

### 39. `review.js:55-68` — `findWordConfidence` O(N×M) linear scan

For every cleaned word, linearly scans all alignment words. Also returns the first text match regardless of position, which could match the wrong occurrence of a repeated word.

---

## Minor / Code Quality

### 40. `state.js:385` — Sort treats `0` as empty string

`let va = a[sortCol] || '';` — if value is `0`, becomes `''`, breaking numeric sort.

### 41. `state.js:206` — Non-unique version IDs on sub-millisecond calls

`Date.now()` has millisecond resolution. Two rapid calls with same audioId and type produce identical IDs.

### 42. `state.js:414` — `fiftyStatusCounts` missing `rejected` key

`fiftyStatusCounts[s]++` silently fails (NaN) for rejected 50hr files. They become invisible in the 50hr view.

### 43. `app.js:371-394` — `expandedRow` conflates highlighted row and expanded panel

Arrow keys set `expandedRow` (line 392), but `onRowExpand` (line 66) uses it to toggle-close panels. These are two different concepts sharing one variable.

### 44. `detail.js:2365-2413` — Dead code: `wordDiffTokens` (48 lines)

Per CLAUDE.md: "no longer used for rendering diffs."

### 45. `style.css:23-24` — Duplicate CSS variables

`--blue: #2563eb` and `--accent: #2563eb` are identical. `--blue-dim` and `--accent-dim` likewise.

### 46. `style.css:222` — Permanent 80px bottom padding for conditional bulk bar

`padding: 0 24px 80px` provides space for the bulk action bar even when no rows are selected.

### 47. `login.html:9-15` — Body style conflict with stylesheet

Inline style doesn't override `flex-direction: column` from `style.css`. Login card centering works by accident.

---

## Summary

| Severity | Count | Key Examples |
|----------|-------|-------------|
| Critical | 8 | Inline review panel missing, cleanParentheses keeps content, approve on benchmarks |
| Significant | 10 | mergeSupabase doesn't truly replace, score cap defeats tiebreakers, race conditions |
| Redundancy | 9 | Duplicate search modal, duplicate formatting, duplicate fetch patterns |
| Security | 2 | Open CORS on paid GPU endpoint, no hostname validation on transcript proxy |
| Data Integrity | 6 | No retry on sync, partial data silent, export omits renames |
| Performance | 4 | transcript_edits full fetch, O(n²) lookups, event listener leaks |
| Minor | 8 | Dead code, duplicate CSS vars, sort edge cases |
