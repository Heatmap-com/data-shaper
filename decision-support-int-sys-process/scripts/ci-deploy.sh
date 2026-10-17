#!/usr/bin/env bash
# Runs on the deploy box from Bitbucket Pipelines.
# Updates only ~/analysis-engine. Does not touch landing-page-analysis,
# its containers, image tag, volumes, or ci-deploy.sh.
set -euo pipefail

root="${HOME}/analysis-engine"
cd "$root"
if [[ "$(pwd -P)" != "$(realpath "${HOME}/analysis-engine")" ]]; then
  echo "refusing to deploy outside ~/analysis-engine" >&2
  exit 1
fi

git fetch origin
git reset --hard origin/main

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed on the box" >&2
  exit 1
fi

npm ci --omit=dev --no-audit --no-fund

unit="analysis-capture.service"
if [[ -f "${root}/.env" ]] && systemctl cat "$unit" >/dev/null 2>&1; then
  sudo systemctl restart "$unit"
  echo "[ci-deploy] restarted ${unit}"
else
  echo "[ci-deploy] code updated; capture unit not restarted (no .env or unit is not installed)"
fi

echo "[ci-deploy] analysis-engine $(git rev-parse --short HEAD)"
