#!/bin/bash
# headless-goal-loop.sh — 24/7 goal-mode runner for headless `opencode run`.
#
# WHY THIS EXISTS:
# `opencode run "/goal <objective>"` does NOT expand the /goal slash command.
# The text is delivered to the model as a plain prompt, so no goal is ever
# written to plugin storage and the plugin's auto-continue machinery never
# engages (verified: get_goal -> "No active goal"). Until headless slash
# expansion exists, goal semantics live here instead:
#   - the goal text is injected verbatim on every attempt
#   - attempts repeat until the model prints GOAL_COMPLETE
#   - rate-limit signals trigger exponential backoff, then resume
#   - an optional ON_BATCH_DONE hook runs after each completed batch
#     (e.g. push work to git)
#
# This loop never exits on its own. Pair with a watchdog (cron, systemd,
# or a scheduler) that restarts it if the process dies. It takes a lock
# so overlapping watchdog ticks can't start a second copy.
#
# USAGE:
#   GOAL_FILE=goal.txt MODEL=opencode/muse-spark-1.3-contributor-free \
#     ON_BATCH_DONE="gh-sync ~/repos/atelier modpotato/atelier main" \
#     ./headless-goal-loop.sh
#
# CONFIG (env vars):
#   GOAL_FILE        file containing the goal text (required)
#   MODEL            opencode model for --model (default: opencode/muse-spark-1.3-contributor-free)
#   WORKDIR          cd here each iteration (default: $PWD at start)
#   ON_BATCH_DONE    shell command run after each GOAL_COMPLETE batch (default: none)
#   ATTEMPT_TIMEOUT  seconds per model attempt (default: 600)
#   BREATHER_SECS    pause between completed batches (default: 30)
#   BACKOFF_START    rate-limit backoff start seconds (default: 120; doubles to BACKOFF_MAX)
#   BACKOFF_MAX      (default: 1800)
#   LOG              log file (default: ./goal-loop.log)
#   STATE            json state file (default: ./goal-loop-state.json)
#   LOCK             lock file (default: ./goal-loop.lock)
set -u

: "${GOAL_FILE:?set GOAL_FILE to a file containing the goal text}"
MODEL="${MODEL:-opencode/muse-spark-1.3-contributor-free}"
WORKDIR="${WORKDIR:-$PWD}"
ON_BATCH_DONE="${ON_BATCH_DONE:-}"
ATTEMPT_TIMEOUT="${ATTEMPT_TIMEOUT:-600}"
BREATHER_SECS="${BREATHER_SECS:-30}"
BACKOFF_START="${BACKOFF_START:-120}"
BACKOFF_MAX="${BACKOFF_MAX:-1800}"
LOG="${LOG:-./goal-loop.log}"
STATE="${STATE:-./goal-loop-state.json}"
LOCK="${LOCK:-./goal-loop.lock}"

export PATH="$HOME/.opencode/bin:$PATH"
GOAL="$(cat "$GOAL_FILE")"

mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
if ! flock -n 9; then
  exit 0  # already running — exit silently
fi

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

record_batch() { # <pushed:yes|no> <detail>
  python3 - "$STATE" "$1" "$2" <<'PYEOF'
import json, sys, datetime
path, pushed, detail = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path))
except Exception:
    d = {}
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
d["status"] = "running"
d["batches_completed"] = d.get("batches_completed", 0) + 1
if pushed == "yes":
    d["batches_pushed"] = d.get("batches_pushed", 0) + 1
    d["consecutive_no_push"] = 0
    d["last_push_at"] = now
else:
    d["consecutive_no_push"] = d.get("consecutive_no_push", 0) + 1
d["last_iter_at"] = now
d["last_detail"] = detail
json.dump(d, open(path, "w"))
PYEOF
}

log "headless goal loop start (pid $$) model=$MODEL"
BACKOFF=$BACKOFF_START
ITER=0
while true; do
  ITER=$((ITER + 1))
  cd "$WORKDIR" || { log "iter $ITER FATAL: workdir missing"; sleep 300; continue; }

  # ---- goal attempts: unlimited until GOAL_COMPLETE ----
  log "iter $ITER batch start"
  GOAL_DONE=no
  ATTEMPT=0
  while [ "$GOAL_DONE" = "no" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    LOG_MARK=$(wc -c < "$LOG")
    if [ "$ATTEMPT" -eq 1 ]; then
      PROMPT="$GOAL"
    else
      PROMPT="Continue working toward the goal. Your previous attempt ended without signalling GOAL_COMPLETE, so something is unfinished — finish it. $GOAL"
    fi
    timeout "$ATTEMPT_TIMEOUT" opencode run --model "$MODEL" "$PROMPT" < /dev/null >> "$LOG" 2>&1
    log "iter $ITER attempt $ATTEMPT exit: $?"
    NEW_BYTES=$(tail -c +$((LOG_MARK + 1)) "$LOG")
    if printf '%s' "$NEW_BYTES" | grep -q "GOAL_COMPLETE"; then
      GOAL_DONE=yes
    elif printf '%s' "$NEW_BYTES" | grep -qiE "429|rate[ -_]limit|too many requests|quota|overloaded"; then
      log "iter $ITER rate limited on attempt $ATTEMPT"
      GOAL_DONE=limited
    fi
  done

  if [ "$GOAL_DONE" = "limited" ]; then
    log "iter $ITER backing off ${BACKOFF}s"
    sleep "$BACKOFF"
    BACKOFF=$((BACKOFF * 2))
    [ "$BACKOFF" -gt "$BACKOFF_MAX" ] && BACKOFF=$BACKOFF_MAX
    continue
  fi
  BACKOFF=$BACKOFF_START
  log "iter $ITER batch done after $ATTEMPT attempt(s)"

  if [ -n "$ON_BATCH_DONE" ]; then
    HOOK_OUT=$(bash -c "$ON_BATCH_DONE" 2>&1)
    HOOK_EXIT=$?
    printf '%s\n' "$HOOK_OUT" >> "$LOG"
    if printf '%s' "$HOOK_OUT" | grep -q "^pushed"; then
      record_batch yes "hook exit $HOOK_EXIT"
    else
      record_batch no "hook exit $HOOK_EXIT"
    fi
  else
    record_batch no "no hook configured"
  fi

  sleep "$BREATHER_SECS"
done
