#!/usr/bin/env bash
# Only Apple's observed ticket-delivery connection loss is retryable.
set -uo pipefail
if (( $# == 0 )); then
  echo 'retry-apple-ticket: a command is required' >&2
  exit 64
fi
attempt_log=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/apple-ticket-retry.XXXXXX") || exit 1
trap 'rm -f "$attempt_log"' EXIT
for attempt in 1 2 3; do
  "$@" 2>&1 | tee "$attempt_log"
  statuses=("${PIPESTATUS[@]}")
  status=${statuses[0]}
  if (( ${statuses[1]} != 0 )); then exit "${statuses[1]}"; fi
  if (( status == 0 )); then exit 0; fi
  if (( attempt == 3 )) \
    || ! grep -Fq 'Error Domain=NSURLErrorDomain Code=-1005 ' "$attempt_log" \
    || ! grep -Fq 'https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup' "$attempt_log" \
    || ! grep -Eq 'The (staple and )?validate action failed! Error 68\.' "$attempt_log"; then
    exit "$status"
  fi
  delay=$((attempt * 5))
  echo "Apple ticket delivery lost its connection (-1005/Error 68); retry $((attempt + 1))/3 in ${delay}s." >&2
  sleep "$delay"
done
