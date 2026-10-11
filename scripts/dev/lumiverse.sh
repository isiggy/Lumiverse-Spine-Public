#!/usr/bin/env bash
# Local Lumiverse instance for developing and testing this extension.
#
#   scripts/dev/lumiverse.sh setup    # once per session (~20s): Bun 1.4, clone + install Lumiverse
#   scripts/dev/lumiverse.sh start    # start the server in the background, wait until it answers
#   scripts/dev/lumiverse.sh deploy   # build this extension, install/update it, grant permissions, enable
#   scripts/dev/lumiverse.sh seed     # create a "Spine Test" character + chat, print the chat URL
#   scripts/dev/lumiverse.sh seed-group  # create a group chat of three "Spine Test" characters
#   scripts/dev/lumiverse.sh models   # download the spineboy (Spine 4.1) test model zip
#   scripts/dev/lumiverse.sh e2e      # headless browser: log in, import + bind spineboy, open the chat, screenshot
#        [--model path.zip]           #   test this model instead of spineboy
#        [--slow]                     #   go through a 3 MB/s proxy, like a remote browser
#        [--controls]                 #   also drive every model control and screenshot each one
#        [--group]                    #   test a three-member group chat instead; --model can be
#                                     #   repeated, members get the models in turn
#   scripts/dev/lumiverse.sh stop | status | logs
#
# Everything lives under $LUMI_WORK (default: ${TMPDIR:-/tmp}/lumiverse-dev). In a
# Claude Code session, point it at the session scratchpad. See CLAUDE.md for the
# reasons behind each workaround.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${LUMI_WORK:-${TMPDIR:-/tmp}/lumiverse-dev}"
PORT="${LUMI_PORT:-7860}"
SLOW_PORT=$((PORT + 1))
USER_NAME="${LUMI_USER:-owner}"
USER_PASS="${LUMI_PASS:-spinetest123}"
EXT_ID="spine_avatars"
EXT_PERMS='["generation","characters","chats","chat_mutation","app_manipulation"]'

LUMI="$WORK/Lumiverse"
DATA="$WORK/data"
BUN_DIR="$WORK/bun"
BUN="$BUN_DIR/bun"
PID_FILE="$WORK/server.pid"
LOG="$WORK/server.log"
COOKIES="$WORK/cookies.txt"
BASE="http://127.0.0.1:$PORT"

log() { printf '\033[1;35m[lumi]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[lumi] %s\033[0m\n' "$*" >&2; exit 1; }

is_running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

# ── setup ───────────────────────────────────────────────────────────────────

ensure_bun() {
  if [[ -x "$BUN" ]]; then return; fi
  # Lumiverse refuses to start on Bun < 1.4. bun.sh is blocked by the egress
  # proxy, so take the release zip from GitHub.
  local arch
  case "$(uname -m)" in
    aarch64 | arm64) arch=aarch64 ;;
    *) arch=x64 ;;
  esac
  log "Downloading Bun (linux-$arch) from GitHub releases…"
  mkdir -p "$BUN_DIR"
  curl -fsSL -o "$WORK/bun.zip" "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-$arch.zip"
  unzip -qo "$WORK/bun.zip" -d "$WORK"
  mv "$WORK/bun-linux-$arch/bun" "$BUN"
  rm -rf "$WORK/bun.zip" "$WORK/bun-linux-$arch"
  log "Bun $("$BUN" --version)"
}

cmd_setup() {
  mkdir -p "$WORK"
  ensure_bun

  if [[ ! -d "$LUMI/.git" ]]; then
    log "Cloning Lumiverse…"
    git clone -q --depth 1 https://github.com/prolix-oc/Lumiverse.git "$LUMI"
  fi

  # The container has no IPv6, so binding "::" fails with EAFNOSUPPORT.
  if grep -q 'hostname: "::"' "$LUMI/src/main.ts"; then
    sed -i 's/hostname: "::"/hostname: "0.0.0.0"/' "$LUMI/src/main.ts"
    log "Patched src/main.ts to listen on 0.0.0.0"
  elif ! grep -q 'hostname: "0.0.0.0"' "$LUMI/src/main.ts"; then
    log "WARNING: couldn't find the Bun.serve hostname in src/main.ts; if start fails with EAFNOSUPPORT, set it to \"0.0.0.0\" by hand."
  fi

  if [[ ! -d "$LUMI/node_modules" ]]; then
    log "Installing server dependencies (~1-2 min)…"
    (cd "$LUMI" && "$BUN" install --silent)
  fi
  if [[ ! -f "$LUMI/frontend/dist/index.html" ]]; then
    log "Building the Lumiverse web app (~2-3 min)…"
    (cd "$LUMI/frontend" && "$BUN" install --silent && PATH="$BUN_DIR:$PATH" "$BUN" run build >"$WORK/frontend-build.log" 2>&1) ||
      die "Frontend build failed; see $WORK/frontend-build.log"
  fi
  log "Setup complete in $WORK"
}

# ── start / stop ────────────────────────────────────────────────────────────

cmd_start() {
  [[ -f "$LUMI/frontend/dist/index.html" ]] || die "Run setup first."
  if is_running; then log "Already running (pid $(cat "$PID_FILE")) at $BASE"; return; fi
  [[ "$(http_code "$BASE/")" == "000" ]] || die "Something else is already listening on port $PORT."

  mkdir -p "$DATA"
  # LUMIVERSE_BUN_METHOD/PATH make extension backends run on the same Bun as the
  # server. Without them they use the older `bun` on PATH, the IPC handshake fails
  # ("TypeError: Unable to deserialize data") and the extension backend exits.
  # OWNER_PASSWORD creates the owner account on first boot (otherwise the server
  # exits asking for the setup wizard). TRUSTED_ORIGINS adds the `e2e --slow`
  # proxy port, or logins through it are rejected.
  (
    cd "$LUMI"
    DATA_DIR="$DATA" FRONTEND_DIR="$LUMI/frontend/dist" PORT="$PORT" \
      TRUSTED_ORIGINS="http://localhost:$PORT,http://127.0.0.1:$PORT,http://127.0.0.1:$SLOW_PORT" \
      OWNER_USERNAME="$USER_NAME" OWNER_PASSWORD="$USER_PASS" \
      LUMIVERSE_BUN_METHOD=direct LUMIVERSE_BUN_PATH="$BUN" PATH="$BUN_DIR:$PATH" \
      nohup bash -c 'echo $$ >"$0"; exec "$1" run src/index.ts' "$PID_FILE" "$BUN" >"$LOG" 2>&1 </dev/null &
  )

  log "Starting Lumiverse on $BASE…"
  for _ in $(seq 1 90); do
    if [[ "$(http_code "$BASE/")" == "200" ]]; then
      log "Up (pid $(cat "$PID_FILE")). Login: $USER_NAME / $USER_PASS"
      if grep -q "Unable to deserialize data" "$LOG"; then
        log "WARNING: an extension backend crashed with a Bun IPC mismatch; see $LOG"
      fi
      return
    fi
    if ! is_running; then
      tail -20 "$LOG" >&2
      die "Server exited during startup (full log: $LOG)"
    fi
    sleep 1
  done
  die "Server didn't answer within 90s; see $LOG"
}

cmd_stop() {
  if ! is_running; then log "Not running."; rm -f "$PID_FILE"; return; fi
  local pid; pid="$(cat "$PID_FILE")"
  kill "$pid"
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  log "Stopped."
}

cmd_status() {
  if is_running; then
    log "Running (pid $(cat "$PID_FILE")) at $BASE — HTTP $(http_code "$BASE/")"
    grep -E "\[Spindle(:$EXT_ID)?\]" "$LOG" | tail -5 || true
  else
    log "Not running."
  fi
}

# ── REST helpers (cookie session via better-auth) ──────────────────────────

login() {
  is_running || die "Server isn't running; run start first."
  local code
  code="$(http_code -c "$COOKIES" -H 'Content-Type: application/json' -H "Origin: $BASE" \
    -d "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\"}" "$BASE/api/auth/sign-in/username")"
  [[ "$code" == "200" ]] || die "Login failed (HTTP $code)."
}

api() { # api METHOD PATH [JSON]
  local args=(-s -b "$COOKIES" -H "Origin: $BASE" -X "$1")
  [[ $# -ge 3 ]] && args+=(-H 'Content-Type: application/json' -d "$3")
  curl "${args[@]}" "$BASE$2"
}

json() { "$BUN" -e "const d=JSON.parse(await Bun.stdin.text()); $1"; }

# ── deploy / seed / models / e2e ────────────────────────────────────────────

cmd_deploy() {
  [[ -d "$LUMI" ]] || die "Run setup first."
  ensure_bun
  log "Building the extension…"
  (cd "$REPO" && { [[ -d node_modules ]] || "$BUN" install --silent; } && "$BUN" run --silent build >/dev/null)

  local dest="$DATA/extensions/$EXT_ID/repo"
  mkdir -p "$dest"
  rm -rf "$dest/dist" "$dest/src"
  cp -r "$REPO/spindle.json" "$REPO/package.json" "$REPO/tsconfig.json" "$REPO/dist" "$REPO/src" "$dest/"
  log "Copied extension into $dest"

  is_running || { log "Server not running; it will load the extension on next start."; return; }
  login
  api POST /api/v1/spindle/import-local >/dev/null
  # Note: /api/v1/spindle with a trailing slash returns the web app's HTML.
  local ext
  ext="$(api GET /api/v1/spindle | json "const e=(d.extensions??d).find(x=>x.identifier==='$EXT_ID'); console.log(e ? e.id+' '+e.enabled : '')")"
  [[ -n "$ext" ]] || die "Extension wasn't registered by import-local; see $LOG"
  local id="${ext% *}" enabled="${ext#* }"
  api POST "/api/v1/spindle/$id/permissions" "{\"grant\":$EXT_PERMS}" >/dev/null
  if [[ "$enabled" == "true" ]]; then
    api POST "/api/v1/spindle/$id/restart" >/dev/null
    log "Extension restarted with the new build. Reload the browser tab to pick up frontend changes."
  else
    api POST "/api/v1/spindle/$id/enable" >/dev/null
    log "Extension installed, permissions granted and enabled."
  fi
}

cmd_seed() {
  login
  local char_id chat_id
  char_id="$(api GET '/api/v1/characters?limit=200' | json "const c=(d.data??d).find(x=>x.name==='Spine Test'); console.log(c?c.id:'')")"
  if [[ -z "$char_id" ]]; then
    char_id="$(api POST /api/v1/characters '{"name":"Spine Test","description":"Spine test character","first_mes":"Hello there!"}' | json 'console.log(d.id)')"
    log "Created character Spine Test ($char_id)"
  fi
  chat_id="$(api GET '/api/v1/chats?limit=200' | json "const c=(d.data??d).find(x=>x.character_id==='$char_id'); console.log(c?c.id:'')")"
  if [[ -z "$chat_id" ]]; then
    chat_id="$(api POST /api/v1/chats "{\"character_id\":\"$char_id\"}" | json 'console.log(d.id)')"
    log "Created chat ($chat_id)"
  fi
  echo "$chat_id" >"$WORK/chat-id"
  log "Chat: $BASE/chat/$chat_id"
}

# A group chat of "Spine Test", "Spine Test 2" and "Spine Test 3".
cmd_seed_group() {
  [[ -f "$WORK/chat-id" ]] || cmd_seed
  login
  local ids=() name id chat_id
  for name in "Spine Test" "Spine Test 2" "Spine Test 3"; do
    id="$(api GET '/api/v1/characters?limit=200' | json "const c=(d.data??d).find(x=>x.name==='$name'); console.log(c?c.id:'')")"
    if [[ -z "$id" ]]; then
      id="$(api POST /api/v1/characters "{\"name\":\"$name\",\"description\":\"Spine test character\",\"first_mes\":\"Hello from $name!\"}" | json 'console.log(d.id)')"
      log "Created character $name ($id)"
    fi
    ids+=("$id")
  done
  local members
  members="$(printf '"%s",' "${ids[@]}")"
  members="[${members%,}]"
  # Reuse the group chat from last time while it still has these members.
  chat_id="$(cat "$WORK/group-chat-id" 2>/dev/null || true)"
  if [[ -n "$chat_id" ]]; then
    chat_id="$(api GET "/api/v1/chats/$chat_id" | json "console.log(JSON.stringify(d.metadata?.character_ids)===JSON.stringify($members) ? d.id : '')" 2>/dev/null || true)"
  fi
  if [[ -z "$chat_id" ]]; then
    chat_id="$(api POST /api/v1/chats/group "{\"character_ids\":$members,\"name\":\"Spine Group\"}" | json 'console.log(d.id)')"
    log "Created group chat ($chat_id)"
  fi
  echo "$chat_id" >"$WORK/group-chat-id"
  printf '%s\n' "${ids[@]}" >"$WORK/group-members"
  log "Group chat: $BASE/chat/$chat_id"
}

cmd_models() {
  mkdir -p "$WORK/models"
  local zip="$WORK/models/spineboy.zip"
  if [[ ! -f "$zip" ]]; then
    log "Fetching spineboy (Spine 4.1) from EsotericSoftware/spine-runtimes…"
    local raw="https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/4.1/examples/spineboy/export"
    local dir="$WORK/models/spineboy"
    mkdir -p "$dir"
    for file in spineboy-pro.skel spineboy-pma.atlas spineboy-pma.png; do
      curl -fsSL -o "$dir/$file" "$raw/$file"
    done
    (cd "$WORK/models" && zip -qr "$zip" spineboy)
  fi
  log "Test model: $zip"
}

cmd_e2e() {
  is_running || die "Server isn't running; run start first."
  local model_zips=() slow=false group=false extra=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model) model_zips+=("$(realpath "$2")"); shift 2 ;;
      --slow) slow=true; shift ;;
      --group) group=true; extra+=("$1"); shift ;;
      *) extra+=("$1"); shift ;;
    esac
  done
  [[ -f "$WORK/chat-id" ]] || cmd_seed
  if $group; then cmd_seed_group; fi
  if [[ ${#model_zips[@]} -eq 0 ]]; then
    [[ -f "$WORK/models/spineboy.zip" ]] || cmd_models
    model_zips=("$WORK/models/spineboy.zip")
  fi
  local zip
  for zip in "${model_zips[@]}"; do [[ -f "$zip" ]] || die "No such model zip: $zip"; done
  if [[ ! -d "$WORK/pw/node_modules/playwright" ]]; then
    log "Installing Playwright (uses the preinstalled Chromium)…"
    mkdir -p "$WORK/pw" && (cd "$WORK/pw" && npm init -y >/dev/null && npm install --silent playwright >/dev/null)
  fi

  local base="$BASE" proxy_pid=""
  if $slow; then
    node "$REPO/scripts/dev/throttle-proxy.mjs" "$SLOW_PORT" "$PORT" 3000000 >"$WORK/proxy.log" 2>&1 &
    proxy_pid=$!
    sleep 0.5
    base="http://127.0.0.1:$SLOW_PORT"
    log "Browser traffic goes through a 3 MB/s proxy on $base"
  fi
  local status=0
  PW_DIR="$WORK/pw" LUMI_BASE="$base" LUMI_USER="$USER_NAME" LUMI_PASS="$USER_PASS" \
    LUMI_CHAT_ID="$(cat "$WORK/chat-id")" LUMI_MODEL_ZIP="${model_zips[0]}" LUMI_OUT="$WORK/shots" \
    LUMI_MODEL_ZIPS="$(printf '%s\n' "${model_zips[@]}")" \
    LUMI_GROUP_CHAT_ID="$(cat "$WORK/group-chat-id" 2>/dev/null || true)" \
    LUMI_GROUP_MEMBERS="$(cat "$WORK/group-members" 2>/dev/null || true)" \
    node "$REPO/scripts/dev/e2e.mjs" "${extra[@]}" || status=$?
  [[ -n "$proxy_pid" ]] && kill "$proxy_pid" 2>/dev/null
  return "$status"
}

case "${1:-}" in
  setup) cmd_setup ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) tail -n "${2:-50}" "$LOG" ;;
  deploy) cmd_deploy ;;
  seed) cmd_seed ;;
  seed-group) cmd_seed_group ;;
  models) cmd_models ;;
  e2e) shift; cmd_e2e "$@" ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
