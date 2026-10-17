#!/usr/bin/env bash
# Naming-consumer hook for the kimi box. The analysis engine calls this
# with the queued URL and idsite. It runs cnn-name inside the existing
# naming-bot container, then copies that site's dataset onto the host
# where the consumer reads names.json.
#
# Writer settings are taken from the caller environment (the consumer
# inherits them). They are not stored in this script. The page verb still
# needs GUIDES_ROOT, LATICO_SAMPLES, and the provider key to exist at the
# paths the container can read.
#
# Args: <url> <idsite>
# Env:  NAMING_CONTAINER (required): the naming-bot container name.
#
# Exit contract: 0 = named; 2 = usage (bad/missing args); 3 = missing config
# (NAMING_CONTAINER unset or empty); any other non-zero code is the child's
# status passed through.
set -euo pipefail

url=${1:-}
idsite=${2:-}
if [[ -z "$url" || -z "$idsite" ]]; then
  echo "usage: name-page.sh <url> <idsite>" >&2
  exit 2
fi

if [[ -z "${NAMING_CONTAINER:-}" ]]; then
  echo "missing config: NAMING_CONTAINER must be set" >&2
  exit 3
fi
container=$NAMING_CONTAINER

docker exec \
  -e WRITER_PROVIDER \
  -e WRITER_MODEL \
  -e WRITER_CHEAP_MODEL \
  -e GUIDES_ROOT \
  -e LATICO_SAMPLES \
  -e OPENAI_API_KEY \
  -e ANTHROPIC_API_KEY \
  -e KIMI_API_KEY \
  "$container" \
  pnpm cnn-name page --catalog "/opt/naming-bot/catalogs/${idsite}.yaml" --url "$url"

dest="${HOME}/naming-bot/dataset"
mkdir -p "$dest"
docker cp "${container}:/opt/naming-bot/dataset/${idsite}" "${dest}/"
