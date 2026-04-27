#!/usr/bin/env bash
# Trigger the jem-exporter RunPod endpoint to run the full
# build-training-dataset.sh pipeline in the cloud.
#
# Required env:
#   RUNPOD_API_KEY              — your RunPod account API key
#   RUNPOD_EXPORTER_ENDPOINT    — the endpoint ID (from the RunPod dashboard)
#
# Usage:
#   scripts/run-export-on-runpod.sh                                          # full export, all libraries
#   scripts/run-export-on-runpod.sh --library jemedia                        # one library
#   scripts/run-export-on-runpod.sh --id a_1013 --push-to-hub ABE101/foo     # single file + push
#   scripts/run-export-on-runpod.sh --library jemedia --stage 1              # Stage 1 only
#   scripts/run-export-on-runpod.sh --library jemedia --resume               # only re-export missing
#   scripts/run-export-on-runpod.sh --library jemedia --limit 5              # smoke test
#
# Flags (mirror build-training-dataset.sh):
#   --library <id>        Restrict to one library (default: all)
#   --id <audio_id>       Single-file run (bypasses approved/50hr/benchmark filters)
#   --push-to-hub <repo>  After Stage 2, push to <org>/<repo> on HuggingFace
#   --stage <1|2|both>    Default: both
#   --force               Re-export Stage 1 even if output exists
#   --resume              Skip Stage 1 entries whose output is complete
#   --limit <N>           Stage 1 only: cap number of files
#   --ref <git-ref>       JEM git ref/branch/sha to run on the pod (default: main)
#   --sync                Use /runsync (blocks; only works for fast jobs <240s)
#   --wait                Async + poll status until complete (prints final result)
#   --help

set -euo pipefail

usage() { sed -n '2,30p' "$0" | sed 's/^# \?//'; }

LIBRARY=""; AUDIO_ID=""; PUSH_TO_HUB=""; STAGE=""; FORCE=false; RESUME=false
LIMIT=""; REF=""; SYNC=false; WAIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --library)      LIBRARY="$2"; shift 2;;
    --id)           AUDIO_ID="$2"; shift 2;;
    --push-to-hub)  PUSH_TO_HUB="$2"; shift 2;;
    --stage)        STAGE="$2"; shift 2;;
    --force)        FORCE=true; shift;;
    --resume)       RESUME=true; shift;;
    --limit)        LIMIT="$2"; shift 2;;
    --ref)          REF="$2"; shift 2;;
    --sync)         SYNC=true; shift;;
    --wait)         WAIT=true; shift;;
    --help|-h)      usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

: "${RUNPOD_API_KEY:?Set RUNPOD_API_KEY (RunPod account → Settings → API Keys)}"
: "${RUNPOD_EXPORTER_ENDPOINT:?Set RUNPOD_EXPORTER_ENDPOINT (endpoint ID from dashboard)}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ Required command not found on PATH: $1" >&2
    exit 1
  fi
}
need curl
need jq

# Build JSON body — only include fields the user actually set, so the handler
# can apply its own defaults.
build_input() {
  local args=()
  [[ -n "$LIBRARY"      ]] && args+=("--arg"     library_id  "$LIBRARY")
  [[ -n "$AUDIO_ID"     ]] && args+=("--arg"     audio_id    "$AUDIO_ID")
  [[ -n "$PUSH_TO_HUB"  ]] && args+=("--arg"     push_to_hub "$PUSH_TO_HUB")
  [[ -n "$STAGE"        ]] && args+=("--arg"     stage       "$STAGE")
  [[ -n "$REF"          ]] && args+=("--arg"     ref         "$REF")
  [[ -n "$LIMIT"        ]] && args+=("--argjson" "limit"     "$LIMIT")
  args+=("--argjson" force  "$FORCE")
  args+=("--argjson" resume "$RESUME")

  jq -n "${args[@]}" '
    {input: (
      ({force: $force, resume: $resume})
      + (if $ENV.LIBRARY      != "" then {library_id:  $library_id}  else {} end)
      + (if $ENV.AUDIO_ID     != "" then {audio_id:    $audio_id}    else {} end)
      + (if $ENV.PUSH_TO_HUB  != "" then {push_to_hub: $push_to_hub} else {} end)
      + (if $ENV.STAGE        != "" then {stage:       $stage}       else {} end)
      + (if $ENV.REF          != "" then {ref:         $ref}         else {} end)
      + (if $ENV.LIMIT        != "" then {limit:       $limit}       else {} end)
    )}
  '
}

if [[ "$SYNC" == true && "$WAIT" == true ]]; then
  echo "❌ --sync and --wait are mutually exclusive" >&2
  exit 1
fi

ROUTE="run"
[[ "$SYNC" == true ]] && ROUTE="runsync"
URL="https://api.runpod.ai/v2/${RUNPOD_EXPORTER_ENDPOINT}/${ROUTE}"

PAYLOAD=$(LIBRARY="$LIBRARY" AUDIO_ID="$AUDIO_ID" PUSH_TO_HUB="$PUSH_TO_HUB" \
          STAGE="$STAGE" REF="$REF" LIMIT="$LIMIT" build_input)

echo "▶ POST $URL"
echo "  payload: $(echo "$PAYLOAD" | jq -c .)"

RESP=$(curl -fsS --max-time 600 \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -X POST "$URL" \
  --data-binary "$PAYLOAD")

JOB_ID=$(echo "$RESP" | jq -r '.id // empty')

if [[ "$SYNC" == true ]]; then
  echo "$RESP" | jq .
  STATUS=$(echo "$RESP" | jq -r '.status // empty')
  if [[ "$STATUS" == "COMPLETED" ]]; then
    OUT_STATUS=$(echo "$RESP" | jq -r '.output.status // empty')
    [[ "$OUT_STATUS" == "completed" ]] && exit 0 || exit 1
  fi
  exit 1
fi

if [[ -z "$JOB_ID" ]]; then
  echo "❌ No job id in response:"
  echo "$RESP" | jq .
  exit 1
fi

STATUS_URL="https://api.runpod.ai/v2/${RUNPOD_EXPORTER_ENDPOINT}/status/${JOB_ID}"
echo "✓ Job submitted: $JOB_ID"
echo "  Poll: $STATUS_URL"
echo "  Or:   curl -H \"Authorization: Bearer \$RUNPOD_API_KEY\" $STATUS_URL | jq ."

if [[ "$WAIT" != true ]]; then
  exit 0
fi

echo ""
echo "⏳ Waiting for job to finish (Ctrl-C to detach — job keeps running)…"
PREV=""
while true; do
  R=$(curl -fsS -H "Authorization: Bearer $RUNPOD_API_KEY" "$STATUS_URL" || true)
  S=$(echo "$R" | jq -r '.status // "UNKNOWN"')
  if [[ "$S" != "$PREV" ]]; then
    echo "  status=$S  ($(date -u +%H:%M:%SZ))"
    PREV="$S"
  fi
  case "$S" in
    COMPLETED|FAILED|CANCELLED|TIMED_OUT)
      echo ""
      echo "$R" | jq .
      OUT_STATUS=$(echo "$R" | jq -r '.output.status // empty')
      if [[ "$S" == "COMPLETED" && "$OUT_STATUS" == "completed" ]]; then
        URL=$(echo "$R" | jq -r '.output.dataset_url // empty')
        [[ -n "$URL" ]] && echo "🤗 Dataset: $URL"
        exit 0
      fi
      exit 1
      ;;
  esac
  sleep 10
done
