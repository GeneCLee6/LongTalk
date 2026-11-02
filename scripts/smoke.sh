#!/usr/bin/env bash
# Smoke test after a deploy: the site serves the expected commit, the API answers, a room URL
# falls through to the app, and the brand files are served with their types (e4-t19).
# Usage: scripts/smoke.sh <site-url> <commit>
set -euo pipefail
url="${1:?site url}"
sha="${2:?commit}"
[ -n "$url" ] || { echo "::error::No site URL"; exit 1; }

# A new workers.dev name can take a little while to answer
live=''
for i in $(seq 1 20); do
  live=$(curl -fsS "$url/" | grep -o 'name="app-version" content="[^"]*"' | cut -d'"' -f4 || true)
  echo "attempt $i: live=$live expected=$sha"
  [ "$live" = "$sha" ] && break
  sleep 6
done
[ "$live" = "$sha" ] || { echo "::error::Site is not serving $sha"; exit 1; }

# The assets can answer the new version a moment before the Worker's routes do
version=''
for i in $(seq 1 10); do
  version=$(curl -fsS "$url/api/health" | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || true)
  echo "/api/health -> $version"
  [ "$version" = "$sha" ] && break
  sleep 3
done
[ "$version" = "$sha" ] || { echo "::error::/api/health is not answering $sha"; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' "$url/r/smoke-test")
echo "/r/smoke-test -> $code"
[ "$code" = "200" ] || exit 1

# The brand files (e4-t19): served, with the right type; the manifest names LongTalk
check() {
  local path="$1" type="$2" got
  got=$(curl -fsS -o /dev/null -w '%{http_code} %{content_type}' "$url$path" || true)
  echo "$path -> $got"
  case "$got" in
    "200 $type"*) ;;
    *) echo "::error::$path should be 200 $type, got: $got"; exit 1 ;;
  esac
}
check /favicon.svg image/svg+xml
check /favicon.ico image/
check /apple-touch-icon.png image/png
check /icons/icon-192.png image/png
check /icons/icon-maskable-512.png image/png
check /og-image.png image/png
check /manifest.webmanifest application/manifest+json
curl -fsS "$url/manifest.webmanifest" | grep -q '"short_name": "LongTalk"' \
  || { echo "::error::manifest.webmanifest does not name LongTalk"; exit 1; }
curl -fsS "$url/" | grep -q '<link rel="manifest" href="/manifest.webmanifest"' \
  || { echo "::error::index.html does not link the manifest"; exit 1; }
