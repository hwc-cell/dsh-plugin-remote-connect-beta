#!/usr/bin/env bash
# 端到端验证：把一个**隔离的** DSH 实例拉起来，把本仓库作为插件装进去，
# 然后检查 host 半与 client 半是否真的工作。
#
# 不动你正在用的 DSH：独立 DSH_HOME、独立端口、独立进程，跑完即清理。
#
#   test/e2e-isolated.sh                       # 默认用 DSH Desktop 的安装路径
#   APP=/path/to/app test/e2e-isolated.sh      # 或指定 app 目录（含 node_modules）
#
# 退出码 0 = 全部通过。
set -uo pipefail

APP="${APP:-/Applications/DSH Desktop.app/Contents/Resources/app}"
RESOURCES="$(dirname "$APP")"
NODE="$APP/node_modules/node/bin/node"
ENTRY="$RESOURCES/harness-node-entry.mjs"
DSH="$APP/node_modules/@deepseek-ai/dsh/lib/bin.js"
PORT="${PORT:-4477}"
LAN_PORT="${LAN_PORT:-8891}"
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-e2e-XXXXXX")"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME_DIR/harness.log"
PID=""

passed=0
failed=0
ok()   { passed=$((passed+1)); printf '✔ %s\n' "$1"; }
bad()  { failed=$((failed+1)); printf '✖ %s\n' "$1"; }
cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

for path in "$NODE" "$ENTRY" "$DSH"; do
  if [ ! -e "$path" ]; then
    echo "找不到 ${path}；用 APP=/path/to/app 指定安装目录" >&2
    exit 2
  fi
done

# 1) 隔离 profile：把本仓库当作依赖链进去 + 写 patch
mkdir -p "$HOME_DIR/profiles/web/node_modules" "$HOME_DIR/cache"
ln -sfn "$REPO" "$HOME_DIR/profiles/web/node_modules/dsh-plugin-remote-connect"
cat > "$HOME_DIR/profiles/web/cordis.patch.yml" <<YAML
- insert:
    - id: dsh-plugin-remote-connect
      name: dsh-plugin-remote-connect
      config:
        lan:
          enabled: true
          port: $LAN_PORT
        public:
          enabled: false
YAML

# 2) 启动（不要同时用 --patch 指向同一个文件，否则 patch 会应用两次、
#    报 "duplicate loader entry id"）
cd "$HOME_DIR" || exit 2
DSH_HOME="$HOME_DIR" NO_COLOR=1 NODE_COMPILE_CACHE="$HOME_DIR/cache/compile-cache" \
  "$NODE" --expose-internals "$ENTRY" "$DSH" web --no-open --host 127.0.0.1 --port "$PORT" \
  > "$LOG" 2>&1 &
PID=$!

# 3) 等就绪
for _ in $(seq 1 60); do
  grep -q "dsh web: " "$LOG" && break
  if grep -q "DSH entry failed" "$LOG"; then break; fi
  sleep 1
done

if grep -q "plugin failures" "$LOG"; then
  bad "插件装载失败：$(grep -m1 'plugin failures' "$LOG" | cut -c1-200)"
else
  ok "插件装载无失败记录"
fi

TOKEN="$(grep -o 'dsh web: [^ ]*' "$LOG" | tail -1 | sed 's/.*token=//')"
if [ -z "$TOKEN" ]; then
  bad "Harness 未就绪，日志尾部：$(tail -3 "$LOG" | tr '\n' ' ' | cut -c1-300)"
  echo; echo "$passed 项通过，$failed 项失败"; exit 1
fi
ok "隔离 Harness 已就绪（端口 ${PORT}）"

JAR="$HOME_DIR/cookies.txt"
curl -s -c "$JAR" -o /dev/null "http://127.0.0.1:$PORT/?token=$TOKEN"

# 4) host 半：路由 + 状态
STATE="$(curl -s -b "$JAR" "http://127.0.0.1:$PORT/remote-connect/api/state")"
if printf '%s' "$STATE" | grep -q '"ok":true'; then
  ok "host 半 API 可用（/remote-connect/api/state）"
else
  bad "host 半 API 无响应：$(printf '%s' "$STATE" | cut -c1-160)"
fi
if printf '%s' "$STATE" | grep -q "\"url\":\"http://[0-9.]*:$LAN_PORT/\""; then
  ok "局域网入口已由插件开启（:${LAN_PORT}）"
else
  bad "局域网入口未开启：$(printf '%s' "$STATE" | cut -c1-200)"
fi

# 5) client 半：进入 boot 图
if curl -s -b "$JAR" "http://127.0.0.1:$PORT/" | grep -q 'dsh-plugin-remote-connect'; then
  ok "client 半已进入 boot 图"
else
  bad "client 半不在 boot 图里"
fi

# 6) 插件自己开的入口能换到 Cookie
LAN_IP="$(printf '%s' "$STATE" | sed -n 's/.*"url":"http:\/\/\([0-9.]*\):.*/\1/p' | head -1)"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://$LAN_IP:$LAN_PORT/" || true)"
if [ "$CODE" = "303" ]; then
  ok "局域网入口可达并完成令牌交换（http://$LAN_IP:$LAN_PORT/ → 303）"
else
  bad "局域网入口返回 ${CODE}（期望 303）"
fi

echo
echo "$passed 项通过，$failed 项失败"
[ "$failed" -eq 0 ]
