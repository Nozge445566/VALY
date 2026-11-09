#!/usr/bin/env bash
# Calls one of our Supabase Edge Functions (service role) from a nightly GitHub workflow.
#   usage: bash scripts/call-edge-function.sh <function-name> <output-file>
# Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (GitHub secrets).
#
# Built so a night does not fail for a reason that goes away by itself:
#   - up to 4 attempts, waiting 15 s, 45 s, 90 s between them
#   - a network error, a timeout, a 408/429 or a 5xx is retried (cold start, a short Supabase hiccup)
#   - a 401/403 (wrong key) or 404 (function not deployed) is NOT retried: it needs a human, so it fails at once with a
#     plain message saying what to do
# A real, lasting problem still fails the run (and GitHub tells you); it is never hidden.
set -u

fn="${1:?function name missing}"
out="${2:?output file missing}"

# A pasted secret often carries a stray newline or space: strip them.
SUPABASE_URL="$(printf '%s' "${SUPABASE_URL:-}" | tr -d '[:space:]')"
SUPABASE_SERVICE_ROLE_KEY="$(printf '%s' "${SUPABASE_SERVICE_ROLE_KEY:-}" | tr -d '[:space:]')"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "::error title=Secrets missing::GitHub secrets SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must exist (repo Settings -> Secrets and variables -> Actions)."
  exit 1
fi
echo "::add-mask::${SUPABASE_SERVICE_ROLE_KEY}"

base="${SUPABASE_URL%/}"
case "$base" in
  http://*|https://*) ;;
  *) echo "::error title=Bad SUPABASE_URL::SUPABASE_URL must start with https:// (looks like: ${base:0:12}...)"; exit 1 ;;
esac
url="${base}/functions/v1/${fn}"

read -r -a delays <<< "${CALL_RETRY_DELAYS:-0 15 45 90}" # seconds before each attempt (tests set small ones)
code="000"
for attempt in 1 2 3 4; do
  sleep "${delays[$((attempt - 1))]}"
  : > "$out"
  code="$(curl -sS --max-time 150 -X POST "$url" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d '{}' -o "$out" -w '%{http_code}' 2> "${out}.err")" || code="000"
  echo "attempt ${attempt}/4: ${fn} -> HTTP ${code}"
  case "$code" in
    2??) break ;;
    401|403)
      echo "::error title=${fn}: key rejected (HTTP ${code})::The secret SUPABASE_SERVICE_ROLE_KEY is wrong or belongs to another project. Copy the service_role key again from Supabase -> Project Settings -> API."
      break ;;
    404)
      echo "::error title=${fn}: not deployed (HTTP 404)::Run: supabase functions deploy ${fn}"
      break ;;
    000|408|429|5??) ;; # try again
    *) break ;;         # any other 4xx: retrying will not help
  esac
done

if [ -s "${out}.err" ]; then echo "curl said: $(head -c 300 "${out}.err")"; fi
rm -f "${out}.err"

{
  echo "### ${fn}: HTTP ${code}"
  echo '```json'
  head -c 20000 "$out"
  echo
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

case "$code" in
  2??) exit 0 ;;
  *)
    echo "---- response body (first 1000 characters) ----"
    head -c 1000 "$out"; echo
    case "$code" in 401|403|404) ;; *) echo "::error title=${fn} failed (HTTP ${code})::See the response body above. If it names a column, constraint or table, a migration is missing: run 'supabase db push'." ;; esac
    exit 1 ;;
esac
