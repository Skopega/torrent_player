#!/bin/sh
# Watchdog-супервизор сервера torrent-player (аналог Windows-панели).
# - запускает node server/dist/index.js
# - авто-рестарт при падении с backoff (1/2/4/8/15c), сброс после 300с стабильной работы
# - heartbeat на /api/health каждые 5с, 3 провала -> kill зависшего процесса -> рестарт
# - crash-loop guard: >=5 падений за 120с -> выход (контейнер перезапустит docker restart policy)
# - при RUTRACKER_HEADED=1 поднимает Xvfb (виртуальный дисплей для headed Chrome)

set -u

APP_CMD="node /app/server/dist/index.js"
HEALTH_URL="http://127.0.0.1:3000/api/health"
SHUTDOWN_URL="http://127.0.0.1:3000/api/shutdown"

HEARTBEAT_INTERVAL="${TP_WATCHDOG_HEARTBEAT:-5}"
HEARTBEAT_MAX_FAILS="${TP_WATCHDOG_MAX_FAILS:-3}"
CRASH_MAX="${TP_WATCHDOG_CRASH_MAX:-5}"
CRASH_WINDOW="${TP_WATCHDOG_CRASH_WINDOW:-120}"
STABLE_RESET="${TP_WATCHDOG_STABLE_RESET:-300}"

CHILD=""
CRASH_FILE="/tmp/tp-crashes"
START_TS=0
XVFB_PID=""

log() { echo "[supervisor] $(date '+%H:%M:%S') $*"; }

is_alive() { [ -n "$CHILD" ] && kill -0 "$CHILD" 2>/dev/null; }

start_xvfb() {
  if [ "${RUTRACKER_HEADED:-0}" = "0" ]; then
    return
  fi
  if [ -z "${DISPLAY:-}" ]; then
    export DISPLAY=:99
  fi
  Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
  XVFB_PID=$!
  log "Xvfb started on $DISPLAY (pid $XVFB_PID)"
}

stop_child() {
  if is_alive; then
    log "graceful shutdown via POST /api/shutdown"
    curl -s -X POST "$SHUTDOWN_URL" -m 10 >/dev/null 2>&1 || true
    i=0
    while is_alive && [ "$i" -lt 20 ]; do
      sleep 0.5
      i=$((i + 1))
    done
    if is_alive; then
      log "killing PID $CHILD (force)"
      kill -KILL "$CHILD" 2>/dev/null || true
    fi
    wait "$CHILD" 2>/dev/null
  fi
  CHILD=""
}

health_monitor() {
  local fails=0
  while :; do
    sleep "$HEARTBEAT_INTERVAL"
    if ! is_alive; then
      fails=0
      continue
    fi
    if curl -fs "$HEALTH_URL" -m 3 >/dev/null 2>&1; then
      fails=0
    else
      fails=$((fails + 1))
      log "health check failed ($fails/$HEARTBEAT_MAX_FAILS)"
      if [ "$fails" -ge "$HEARTBEAT_MAX_FAILS" ]; then
        log "app hung - killing PID $CHILD"
        kill -KILL "$CHILD" 2>/dev/null || true
        fails=0
      fi
    fi
  done
}

# Записываем время падения, вычищаем записи старше CRASH_WINDOW секунд.
record_crash() {
  local now cutoff ts
  now=$(date +%s)
  echo "$now" >> "$CRASH_FILE"
  cutoff=$((now - CRASH_WINDOW))
  : > "$CRASH_FILE.tmp"
  while read -r ts; do
    [ -n "$ts" ] || continue
    if [ "$ts" -ge "$cutoff" ] 2>/dev/null; then
      echo "$ts" >> "$CRASH_FILE.tmp"
    fi
  done < "$CRASH_FILE"
  mv "$CRASH_FILE.tmp" "$CRASH_FILE"
}

crash_count() {
  [ -f "$CRASH_FILE" ] || return 0
  wc -l < "$CRASH_FILE"
}

cleanup() {
  log "shutting down"
  stop_child
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
}

trap 'cleanup; exit 0' TERM INT

rm -f "$CRASH_FILE"
start_xvfb

health_monitor &
HEALTH_PID=$!

log "supervisor started (heartbeat=${HEARTBEAT_INTERVAL}s, max_fails=${HEARTBEAT_MAX_FAILS}, crash_guard=${CRASH_MAX}/${CRASH_WINDOW}s)"

while :; do
  # Очистка застрявших singleton-локов Chrome (после жёсткого перезапуска контейнера
  # Chrome видит мёртвые SingletonLock/Cookie/Socket и не стартует, считая что
  # «другой экземпляр уже запущен»). Удаляем до подъёма сервера.
  rm -f /data/chrome-profile/SingletonLock \
        /data/chrome-profile/SingletonCookie \
        /data/chrome-profile/SingletonSocket
  log "starting app"
  START_TS=$(date +%s)
  # shellcheck disable=SC2086
  $APP_CMD &
  CHILD=$!
  wait "$CHILD"
  code=$?
  CHILD=""

  log "app exited (code $code)"

  # Стабильная работа > STABLE_RESET сек -> сброс счётчика падений.
  if [ "$(( $(date +%s) - START_TS ))" -ge "$STABLE_RESET" ]; then
    rm -f "$CRASH_FILE"
    log "stable run - crash counter reset"
  fi

  record_crash
  c=$(crash_count)
  if [ "$c" -ge "$CRASH_MAX" ]; then
    log "too many crashes ($c in ${CRASH_WINDOW}s) - giving up (docker restart policy will restart container)"
    kill "$HEALTH_PID" 2>/dev/null || true
    exit 1
  fi

  case "$c" in
    1) delay=1 ;;
    2) delay=2 ;;
    3) delay=4 ;;
    *) delay=15 ;;
  esac

  log "restarting in ${delay}s (crash #$c)"
  sleep "$delay"
done
