#!/usr/bin/env bash
# Post-deploy smoke test against the public domain: TLS, routing to all four
# services, HTTP→HTTPS redirect and authentication being enforced.
#   usage: smoke.sh https://baheka-construct-os.com
set -euo pipefail

url="${1:?base URL required}"
host="${url#https://}"
fail=0

check() { # name, expected status, curl args...
  local name="$1" want="$2"
  shift 2
  local got
  got="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --retry 5 --retry-delay 6 --retry-all-errors "$@" || echo 000)"
  if [[ "$got" == "$want" ]]; then
    echo "ok    $name ($got)"
  else
    echo "FAIL  $name: expected $want, got $got"
    fail=1
  fi
}

echo "+++ :mag: Smoke testing $url"
check "web app"                   200 "$url/"
check "core API health"           200 "$url/api/v1/health"
check "sync service health"       200 "$url/sync/health"
check "AI engine health"          200 "$url/ai/health"
check "API requires auth"         401 "$url/api/v1/projects"
check "sync requires auth"        401 "$url/sync/v1/pull"
check "HTTP redirects to HTTPS"   301 "http://$host/"
check "www redirects to apex"     301 "https://www.$host/"

if curl -sS --max-time 15 "$url/" | grep -q "<title>ConstructOS</title>"; then
  echo "ok    web app serves the ConstructOS bundle"
else
  echo "FAIL  web app did not serve the ConstructOS bundle"
  fail=1
fi

exit "$fail"
