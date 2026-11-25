#!/usr/bin/env bash
# Seed a demo battle for reviewers (D65): two demo players, already voting,
# voting open for 7 days. Owner-only: needs the DEMO_SEED_TOKEN secret.
#
#   DEMO_SEED_TOKEN=... scripts/seed-demo.sh                 # live site
#   DEMO_SEED_TOKEN=... APP_URL=http://localhost:5180 scripts/seed-demo.sh
#
# The token is read from $DEMO_SEED_TOKEN or ~/.deepspace/skillclash-demo-token.
# Set it on the worker once with: npx deepspace secrets set DEMO_SEED_TOKEN --stdin
# Refuses (409) while a demo battle is still open.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_URL="${APP_URL:-https://skillclash.app.space}"
TOKEN="${DEMO_SEED_TOKEN:-$(cat "$HOME/.deepspace/skillclash-demo-token" 2>/dev/null || true)}"
[ -n "$TOKEN" ] || { echo "No DEMO_SEED_TOKEN" >&2; exit 1; }
SKILL="${DEMO_SKILL:-Balance a ball on your head for 5 seconds}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The test fixture clip, as H.264 MP4 so iPhones play it. B's copy is
# mirrored and tinted so the two sides look different.
ffmpeg -v error -y -i tests/fixtures/clip.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an "$work/a.mp4"
ffmpeg -v error -y -i tests/fixtures/clip.webm -vf "hflip,hue=h=140" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an "$work/b.mp4"

rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24; }
upload() { # <file> <player id> -> prints the JSON video object
  local key="videos/$2/$(rand).mp4"
  npx deepspace app files put "$1" --key="$key" >/dev/null
  local size dur
  size=$(wc -c <"$1" | tr -d ' ')
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$1")
  printf '{"fileKey":"%s","mimeType":"video/mp4","sizeBytes":%s,"durationSec":%s}' "$key" "$size" "$dur"
}

va=$(upload "$work/a.mp4" demo_player_a)
vb=$(upload "$work/b.mp4" demo_player_b)
body=$(printf '{"skill":"%s","videoA":%s,"videoB":%s}' "$SKILL" "$va" "$vb")

curl -sS -X POST "$APP_URL/api/admin/seed-demo" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "$body" -w '\nHTTP %{http_code}\n'
