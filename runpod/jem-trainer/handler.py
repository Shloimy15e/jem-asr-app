"""
RunPod serverless handler — JEM Whisper fine-tuning.

Runs ivrit-ai's `train-whisper.py` (cloned into the image at /app/asr-training)
against a HuggingFace Hub dataset produced by scripts/build-training-dataset.sh
+ training/push-dataset.sh.

The handler's execution time = the full training job time. Submit via RunPod
`/run` (async) since even smoke runs exceed the `/runsync` 240s limit.

## Input

    {
      "config": "jem_lora_v1",              # required — baked-in config name
                                            # (must match a file in /app/configs/)
      "dataset_repo": "abe1018776/...",     # optional — overrides HF_DATASET_REPO
      "output_model_name": "...",           # optional — overrides OUTPUT_MODEL_NAME
      "max_steps": 10,                      # optional — caps training (smoke test)
      "overrides": {"LEARNING_RATE": "5e-5"} # optional — overrides ANY config key
    }

## Env (set via RunPod secrets on the endpoint, not via job input)

    HF_TOKEN         required — HuggingFace write token
    WANDB_API_KEY    optional — enables W&B tracking
    WANDB_PROJECT    optional — default "jem-whisper-finetune"

## Output (success)

    {
      "status": "completed",
      "config": "jem_lora_v1",
      "dataset": "<org>/<dataset>",
      "model_repo": "<org>/<model>",
      "model_url": "https://huggingface.co/<org>/<model>"
    }

## Output (failure)

    {
      "status": "failed" | "error",
      "error": "human-readable summary",
      "returncode": 1                        # when train-whisper.py exited non-zero
    }
"""

import os
import shlex
import subprocess
import sys
import traceback

import runpod

CONFIGS_DIR = "/app/configs"
IVRIT_DIR = "/app/asr-training"
TRAIN_SCRIPT = os.path.join(IVRIT_DIR, "train-whisper.py")


def parse_env_file(path):
    """Parse a shell-style KEY=VALUE env file, ignoring comments + blanks."""
    env = {}
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            # Strip an inline `# comment` after the value, but only if preceded by a space
            # (avoids breaking values that legitimately contain `#`)
            if " #" in v:
                v = v.split(" #", 1)[0]
            env[k] = v.strip()
    return env


def build_argv(cfg):
    """Translate the config dict into train-whisper.py argv."""
    # Required fields — bail loudly if missing
    required = ["HF_DATASET_REPO", "BASE_MODEL", "TARGET_LANGUAGE",
                "OUTPUT_MODEL_NAME", "HF_MODEL_ORG"]
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        raise ValueError(f"Config missing required keys: {missing}")

    argv = [
        "--use_preprocessed", cfg["HF_DATASET_REPO"],
        "--model_name",       cfg["BASE_MODEL"],
        "--target_language",  cfg["TARGET_LANGUAGE"],
        "--output_model_name", cfg["OUTPUT_MODEL_NAME"],
        "--hf_org_name",      cfg["HF_MODEL_ORG"],
        "--save_only_model",
    ]

    # Optional scalars
    scalar_flags = {
        "PER_DEVICE_TRAIN_BATCH_SIZE": "--per_device_train_batch_size",
        "PER_DEVICE_EVAL_BATCH_SIZE":  "--per_device_eval_batch_size",
        "GRADIENT_ACCUMULATION_STEPS": "--gradient_accumulation_steps",
        "LEARNING_RATE":               "--learning_rate",
        "WARMUP_STEPS":                "--warmup_steps",
        "NUM_TRAIN_EPOCHS":            "--num_train_epochs",
        "WEIGHT_DECAY":                "--weight_decay",
        "MAX_STEPS":                   "--max_steps",
        "EVAL_STEPS":                  "--eval_steps",
        "SAVE_STEPS":                  "--save_steps",
        "LOGGING_STEPS":               "--logging_steps",
        "MAX_CHECKPOINTS_TO_KEEP":     "--max_checkpoints_to_keep",
        "MIXED_PRECISION":             "--mixed_precision",
        "INCLUDE_TIMESTAMPS_PROB":     "--include_timestamps_prob",
        "INCLUDE_PREV_TEXT_PROB":      "--include_prev_text_prob",
        "RUN_NAME":                    "--run_name",
    }
    for key, flag in scalar_flags.items():
        v = cfg.get(key)
        if v not in (None, ""):
            argv.extend([flag, v])

    # Booleans (config "1" → flag present)
    bool_flags = {
        "USE_QLORA":    "--use_qlora",
        "PREDICT_WER":  "--predict_wer",
    }
    for key, flag in bool_flags.items():
        if cfg.get(key) == "1":
            argv.append(flag)

    # Eval datasets (space-separated list)
    eval_ds = (cfg.get("EVAL_DATASETS") or "").strip()
    if eval_ds:
        argv.append("--eval_datasets")
        argv.extend(eval_ds.split())

    return argv


def handler(job):
    try:
        inp = (job or {}).get("input") or {}

        hf_token = os.environ.get("HF_TOKEN")
        if not hf_token:
            return {"status": "error",
                    "error": "HF_TOKEN not set — add as a RunPod secret on this endpoint"}

        # Resolve config file
        config_name = inp.get("config", "jem_lora_v1")
        config_path = os.path.join(CONFIGS_DIR, f"{config_name}.env")
        if not os.path.isfile(config_path):
            return {"status": "error",
                    "error": f"Unknown config '{config_name}'",
                    "available": [os.path.splitext(f)[0]
                                  for f in os.listdir(CONFIGS_DIR) if f.endswith(".env")]}

        # Load config, apply input-level overrides
        cfg = parse_env_file(config_path)
        if "dataset_repo" in inp:       cfg["HF_DATASET_REPO"] = inp["dataset_repo"]
        if "output_model_name" in inp:  cfg["OUTPUT_MODEL_NAME"] = inp["output_model_name"]
        if "max_steps" in inp:          cfg["MAX_STEPS"] = str(inp["max_steps"])
        for k, v in (inp.get("overrides") or {}).items():
            cfg[k] = str(v)

        # Build training argv
        argv = build_argv(cfg)

        # Pass-through env
        env = dict(os.environ)
        env["HF_TOKEN"] = hf_token
        if os.environ.get("WANDB_API_KEY"):
            env.setdefault("WANDB_PROJECT", "jem-whisper-finetune")

        print(f"[handler] config={config_name}", flush=True)
        print(f"[handler] dataset={cfg['HF_DATASET_REPO']}", flush=True)
        print(f"[handler] model={cfg['HF_MODEL_ORG']}/{cfg['OUTPUT_MODEL_NAME']}", flush=True)
        print(f"[handler] argv={shlex.join(argv)}", flush=True)

        # Run training — stream stdout/stderr to pod logs
        proc = subprocess.run(
            [sys.executable, TRAIN_SCRIPT] + argv,
            cwd=IVRIT_DIR,
            env=env,
            check=False,
        )

        if proc.returncode != 0:
            return {"status": "failed",
                    "returncode": proc.returncode,
                    "error": f"train-whisper.py exited with code {proc.returncode} — see pod logs"}

        return {
            "status": "completed",
            "config": config_name,
            "dataset": cfg["HF_DATASET_REPO"],
            "model_repo": f"{cfg['HF_MODEL_ORG']}/{cfg['OUTPUT_MODEL_NAME']}",
            "model_url": f"https://huggingface.co/{cfg['HF_MODEL_ORG']}/{cfg['OUTPUT_MODEL_NAME']}",
        }

    except Exception as e:
        return {"status": "error",
                "error": str(e),
                "traceback": traceback.format_exc()}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
