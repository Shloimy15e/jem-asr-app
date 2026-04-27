"""
RunPod serverless handler — JEM dataset export Stage 1 + 2 (+ optional 3).

Wraps `bash scripts/build-training-dataset.sh` from the JEM repo. The repo
is cloned fresh on every cold start (or fast-forwarded on a warm pod) so the
latest export logic is always used without rebuilding the Docker image.

The handler's execution time = the full export job time. Submit via RunPod
`/run` (async) — even a small library can exceed the `/runsync` 240s limit
because each MP3 has to be downloaded and frame-trimmed.

## Input

    {
      "library_id":   "jemedia",                      # optional — restrict to one library
      "audio_id":     "a_1013",                       # optional — single-file run (auto-bypasses approved/50hr/benchmark filters)
      "push_to_hub":  "ABE101/jem-yi-whisper-2026-04-27", # optional — Stage 3 target repo
      "stage":        "both",                         # optional — "1", "2", or "both" (default "both")
      "force":        false,                          # optional — re-export Stage 1 even if folder exists
      "resume":       false,                          # optional — skip Stage 1 entries whose output is complete
      "limit":        null,                           # optional — Stage 1 cap (smoke testing)
      "ref":          "main"                          # optional — JEM git ref/branch/sha to run (default "main")
    }

## Env (set as RunPod secrets on the endpoint, NOT via job input)

    SUPABASE_URL           required — Stage 1 reads from Supabase
    SUPABASE_SERVICE_KEY   required — service-role JWT (bypasses RLS)
    HF_TOKEN               required if push_to_hub is set — HuggingFace write token

## Output (success)

    {
      "status":         "completed",
      "stage":          "both",
      "library_id":     "jemedia" | null,
      "audio_id":       null | "a_1013",
      "stdout_tail":    "<last 4000 bytes of script stdout>",
      "dataset_repo":   "ABE101/..." (if pushed),
      "dataset_url":    "https://huggingface.co/datasets/..." (if pushed)
    }

## Output (failure)

    {
      "status":      "failed" | "error",
      "returncode":  <int>,                # when the bash script exited non-zero
      "error":       "human-readable summary",
      "stderr_tail": "<last 4000 bytes of stderr>",
      "stdout_tail": "<last 4000 bytes of stdout>"
    }
"""

import os
import shlex
import shutil
import subprocess
import sys
import traceback

import runpod

JEM_REPO = os.environ.get("JEM_REPO", "https://github.com/Abe1018776/jem-asr-app.git")
JEM_REF_DEFAULT = os.environ.get("JEM_REF", "main")
WORK_DIR = os.environ.get("JEM_WORK_DIR", "/work/jem-asr-app")

PREBUILT_IVRIT = "/app/vendor/asr-training"
TAIL_BYTES = 4000


def _run(cmd, cwd=None, env=None, check=True):
    """Run a subprocess, raising with stderr on failure."""
    print(f"[handler] $ {shlex.join(cmd)}", flush=True)
    proc = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if proc.stdout:
        print(proc.stdout, flush=True, end="")
    if proc.stderr:
        print(proc.stderr, flush=True, end="", file=sys.stderr)
    if check and proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} exited with {proc.returncode}: {proc.stderr.strip()[-500:]}")
    return proc


def clone_or_update_jem(ref):
    """Clone the JEM repo into WORK_DIR, or fast-forward an existing clone to <ref>."""
    if os.path.isdir(os.path.join(WORK_DIR, ".git")):
        _run(["git", "fetch", "--depth", "1", "origin", ref], cwd=WORK_DIR)
        _run(["git", "reset", "--hard", "FETCH_HEAD"], cwd=WORK_DIR)
        _run(["git", "clean", "-fdx", "-e", "node_modules", "-e", "vendor"], cwd=WORK_DIR)
    else:
        os.makedirs(os.path.dirname(WORK_DIR), exist_ok=True)
        _run(["git", "clone", "--depth", "1", "--branch", ref, JEM_REPO, WORK_DIR])


def link_prebuilt_ivrit():
    """Symlink the pre-built ivrit-ai venv into the cloned JEM repo's vendor/.
    The build-training-dataset.sh script's bootstrap block sees an existing
    venv with all imports working and skips both the clone and pip install.
    """
    target = os.path.join(WORK_DIR, "vendor", "asr-training")
    os.makedirs(os.path.join(WORK_DIR, "vendor"), exist_ok=True)
    if os.path.lexists(target):
        if os.path.islink(target):
            os.unlink(target)
        elif os.path.isdir(target):
            shutil.rmtree(target)
        else:
            os.unlink(target)
    os.symlink(PREBUILT_IVRIT, target)


def write_env_file(secrets):
    """Write a .env file at the repo root so the bash script can pick up
    SUPABASE_URL + SUPABASE_SERVICE_KEY (Stage 1) without leaking secrets
    into argv or container env."""
    keys = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "HF_TOKEN")
    lines = []
    for k in keys:
        v = secrets.get(k)
        if v:
            lines.append(f"{k}={v}")
    # The script also accepts VITE_SUPABASE_URL as a fallback for SUPABASE_URL
    if secrets.get("SUPABASE_URL"):
        lines.append(f"VITE_SUPABASE_URL={secrets['SUPABASE_URL']}")
    path = os.path.join(WORK_DIR, ".env")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(path, 0o600)


def build_argv(inp):
    """Translate the job input into args for build-training-dataset.sh."""
    argv = []

    stage = str(inp.get("stage", "both"))
    if stage not in ("1", "2", "both"):
        raise ValueError(f"stage must be '1', '2', or 'both' (got: {stage!r})")
    argv.extend(["--stage", stage])

    out_dir = inp.get("out_dir") or "/work/dist-training"
    argv.extend(["--out", out_dir])

    if inp.get("library_id"):
        argv.extend(["--library", str(inp["library_id"])])
    if inp.get("audio_id"):
        argv.extend(["--id", str(inp["audio_id"])])
    if inp.get("push_to_hub"):
        argv.extend(["--push-to-hub", str(inp["push_to_hub"])])
    if inp.get("limit") not in (None, ""):
        argv.extend(["--limit", str(inp["limit"])])
    if inp.get("force"):
        argv.append("--force")
    if inp.get("resume"):
        argv.append("--resume")

    return argv


def handler(job):
    try:
        inp = (job or {}).get("input") or {}

        # ── Required secrets ─────────────────────────────────────────────
        secrets = {k: os.environ.get(k) for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "HF_TOKEN")}
        if not secrets["SUPABASE_URL"] or not secrets["SUPABASE_SERVICE_KEY"]:
            return {
                "status": "error",
                "error": "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set as endpoint secrets",
            }
        if inp.get("push_to_hub") and not secrets.get("HF_TOKEN"):
            return {
                "status": "error",
                "error": "push_to_hub was specified but HF_TOKEN secret is not set on this endpoint",
            }

        # ── Sync repo + wire up pre-built ivrit-ai venv ──────────────────
        ref = str(inp.get("ref") or JEM_REF_DEFAULT)
        clone_or_update_jem(ref)
        link_prebuilt_ivrit()
        write_env_file(secrets)

        # ── Run the bash pipeline end-to-end ─────────────────────────────
        argv = ["bash", "scripts/build-training-dataset.sh"] + build_argv(inp)

        env = dict(os.environ)
        # Make sure the venv we baked is what the script discovers
        env["PATH"] = "/app/vendor/asr-training/.venv/bin:" + env.get("PATH", "")
        env["PYTHONIOENCODING"] = "utf-8"

        print(f"[handler] cwd={WORK_DIR}", flush=True)
        print(f"[handler] ref={ref}", flush=True)
        print(f"[handler] cmd={shlex.join(argv)}", flush=True)

        proc = subprocess.run(
            argv,
            cwd=WORK_DIR,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

        # Mirror tails to pod logs (RunPod truncates very long logs)
        if proc.stdout:
            print("--- stdout (full) ---", flush=True)
            print(proc.stdout, flush=True, end="")
        if proc.stderr:
            print("--- stderr (full) ---", flush=True, file=sys.stderr)
            print(proc.stderr, flush=True, end="", file=sys.stderr)

        if proc.returncode != 0:
            return {
                "status": "failed",
                "returncode": proc.returncode,
                "error": f"build-training-dataset.sh exited with code {proc.returncode}",
                "stderr_tail": proc.stderr[-TAIL_BYTES:],
                "stdout_tail": proc.stdout[-TAIL_BYTES:],
            }

        result = {
            "status": "completed",
            "stage": str(inp.get("stage", "both")),
            "library_id": inp.get("library_id"),
            "audio_id": inp.get("audio_id"),
            "stdout_tail": proc.stdout[-TAIL_BYTES:],
        }
        if inp.get("push_to_hub"):
            repo = str(inp["push_to_hub"])
            result["dataset_repo"] = repo
            result["dataset_url"] = f"https://huggingface.co/datasets/{repo}"
        return result

    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
