#!/bin/bash
# Run a loader on a schedule inside the data image (used by docker-compose.yml).
#
#   scheduler.sh weather|cifp       run once at startup (CIFP only if stale), then
#                                   hand over to supercronic
#   scheduler.sh run weather|cifp   one run; used by the crontab
#
# Env: WEATHER_SCHEDULE (default "45 * * * *"), CIFP_SCHEDULE (default "0 0 * * 0"),
# CIFP_MAX_STARTUP_AGE_DAYS (default 7), DATA_DIR (default /data),
# KUMA_PUSH_URL_WEATHER / KUMA_PUSH_URL_CIFP (optional, requested after a successful run).
# A failed run is logged and never stops the scheduler.

DATA_DIR="${DATA_DIR:-/data}"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")" || exit 1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] scheduler: $*"; }

script_for() {
  case "$1" in
    weather) echo load_weather.py ;;
    cifp) echo load_cifp.py ;;
    *) return 1 ;;
  esac
}

push_url_for() {
  case "$1" in
    weather) echo "${KUMA_PUSH_URL_WEATHER:-}" ;;
    cifp) echo "${KUMA_PUSH_URL_CIFP:-}" ;;
  esac
}

run_job() {
  local job="$1" script url rc
  script="$(script_for "$job")" || { log "unknown job: $job"; return 2; }
  log "$job: starting"
  python3 -u "$script" --output-dir "$DATA_DIR" --format parquet
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "$job: FAILED (exit $rc); will retry at the next scheduled time"
    return 1
  fi
  log "$job: finished OK"
  url="$(push_url_for "$job")"
  if [ -n "$url" ]; then
    if python3 -c 'import sys, requests; requests.get(sys.argv[1], timeout=10).raise_for_status()' "$url"; then
      log "$job: pushed heartbeat"
    else
      log "$job: heartbeat push failed"
    fi
  fi
}

# True when the status file is missing or older than N days.
stale() {
  local file="$DATA_DIR/$1" days="$2"
  [ ! -f "$file" ] || [ -n "$(find "$file" -mtime +"$((days - 1))" 2>/dev/null)" ]
}

if [ "$1" = run ]; then
  run_job "$2"
  exit $?
fi

job="$1"
script_for "$job" >/dev/null || { echo "usage: $0 weather|cifp" >&2; exit 2; }

case "$job" in
  weather)
    schedule="${WEATHER_SCHEDULE:-45 * * * *}"; status=weather.status.json; max_age=0 ;;
  cifp)
    schedule="${CIFP_SCHEDULE:-0 0 * * 0}"; status=aeronautical.status.json
    max_age="${CIFP_MAX_STARTUP_AGE_DAYS:-7}" ;;
esac

if [ "$max_age" = 0 ]; then
  run_job "$job" || true
elif stale "$status" "$max_age"; then
  run_job "$job" || true
else
  log "$job: $status is newer than $max_age days, skipping startup load"
fi

crontab_file="$(mktemp)"
echo "$schedule $SELF run $job" > "$crontab_file"
log "$job: schedule '$schedule'"
supercronic -test "$crontab_file" || { log "invalid schedule"; exit 2; }
exec supercronic "$crontab_file"
