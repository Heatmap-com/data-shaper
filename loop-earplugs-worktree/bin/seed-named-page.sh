#!/usr/bin/env bash
# Harvest one queued page into dataset/{idsite}/{kind}/{slug}/names.json.
# The analysis naming consumer reads that file. `cnn-name page` also requires
# a writer and a pre-built catalog, and exits before the harvest; `seed`
# is the harvest and does not.
#
# Args: <url> <idsite>
# Env:  NAMING_ENGINE_ASSETS (required). CNN_AI_BOT_DIR is required on the
# host path. The docker path (NAMING_DOCKER_CONTAINER) does not use it.
#
# Exit contract: 0 = named; 2 = usage (bad/missing args); 3 = missing config
# (a required env var is unset or empty); any other non-zero code is the
# child's status passed through. A required env var that is set but points at
# a nonexistent directory is NOT exit 3: the script proceeds and fails
# naturally (the cd or the child exits non-zero), so the defect surfaces.
set -euo pipefail

url=${1:-}
idsite=${2:-}
if [[ -z "$url" || ! "$idsite" =~ ^[0-9]+$ ]]; then
  echo "usage: seed-named-page.sh <url> <idsite>" >&2
  exit 2
fi

if [[ -z "${NAMING_ENGINE_ASSETS:-}" ]]; then
  echo "missing config: NAMING_ENGINE_ASSETS must be set" >&2
  exit 3
fi
assets=$NAMING_ENGINE_ASSETS

origin=$(python3 -c 'import sys; from urllib.parse import urlparse; u=urlparse(sys.argv[1]); print(f"{u.scheme}://{u.netloc}")' "$url")
host=$(python3 -c 'import sys; from urllib.parse import urlparse; h=urlparse(sys.argv[1]).hostname or ""; print(h.removeprefix("www."))' "$url")

catalog=$(mktemp)
trap 'rm -f "$catalog"' EXIT
cat > "$catalog" <<EOF
siteId: ${idsite}
domain: ${host}
origins:
  - ${origin}
pageTypes: []
EOF

# On the kimi box the bot and Chromium live in the naming-bot container.
# The Mac batch leaves this unset and runs the checkout on the host.
if [[ -n "${NAMING_DOCKER_CONTAINER:-}" ]]; then
  container=$NAMING_DOCKER_CONTAINER
  remote_catalog="/tmp/naming-catalog-${idsite}-$$.yaml"
  assets_in_container=${NAMING_ENGINE_ASSETS_CONTAINER:-/opt/naming-assets}
  dataset_in_container=${NAMING_DATASET_CONTAINER:-/opt/naming-bot/dataset}
  host_dataset=${NAMING_DATASET_ROOT:-${HOME}/naming-bot/dataset}
  chmod 644 "$catalog"
  docker cp "$catalog" "${container}:${remote_catalog}"
  set +e
  docker exec \
    -e "NAMING_ENGINE_ASSETS=${assets_in_container}" \
    -w /opt/naming-bot \
    "$container" \
    node bin/cnn-name.mjs seed --catalog "$remote_catalog" --url "$url"
  status=$?
  set -e
  docker exec -u root "$container" rm -f "$remote_catalog" || true
  if [[ $status -ne 0 ]]; then
    exit "$status"
  fi
  mkdir -p "$host_dataset"
  docker cp "${container}:${dataset_in_container}/${idsite}" "${host_dataset}/"
  exit 0
fi

if [[ -z "${CNN_AI_BOT_DIR:-}" ]]; then
  echo "missing config: CNN_AI_BOT_DIR must be set" >&2
  exit 3
fi
bot_dir=$CNN_AI_BOT_DIR

if [[ ! -d "$assets" ]]; then
  echo "NAMING_ENGINE_ASSETS directory not found: $assets" >&2
  exit 1
fi
export NAMING_ENGINE_ASSETS="$assets"
cd "$bot_dir"
exec node bin/cnn-name.mjs seed --catalog "$catalog" --url "$url"
