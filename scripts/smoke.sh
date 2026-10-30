#!/usr/bin/env bash
# Smoke test after a deploy: the site serves the expected commit, the API answers, and a room URL
# falls through to the app. Usage: scripts/smoke.sh <site-url> <commit>
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
