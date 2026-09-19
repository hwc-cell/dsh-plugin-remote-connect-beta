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
  if [ -n "${CLI_PID:-}" ] && kill -0 "$CLI_PID" 2>/dev/null; then
    kill "$CLI_PID" 2>/dev/null
    wait "$CLI_PID" 2>/dev/null
  fi
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  # 子进程刚退出时可能还在写 compile-cache：等一下再删，删不干净也不影响结论
  sleep 1
  rm -rf "$HOME_DIR" 2>/dev/null || true
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
        tenants:
          enabled: true
          registry: $HOME_DIR/tenants.json
          baseDir: $HOME_DIR/homes
          autostart: false
          harness:
            bin: $DSH
            node: $NODE
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
  ok "局域网入口已由插件开启（:${LAN_PORT} ）"
else
  bad "局域网入口未开启：$(printf '%s' "$STATE" | cut -c1-200)"
fi

# 5) client 半：进入 boot 图
if curl -s -b "$JAR" "http://127.0.0.1:$PORT/" | grep -q 'dsh-plugin-remote-connect'; then
  ok "client 半已进入 boot 图"
else
  bad "client 半不在 boot 图里"
fi

# 6) 入口可达性
LAN_IP="$(printf '%s' "$STATE" | sed -n 's/.*"url":"http:\/\/\([0-9.]*\):.*/\1/p' | head -1)"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://$LAN_IP:$LAN_PORT/" || true)"
# 多租户下没有"全局密钥"：不带 ?k= 的请求必须被拒（404），而不是放进某个人的实例
if [ "$CODE" = "404" ]; then
  ok "多租户下匿名访问入口被拒（http://${LAN_IP}:${LAN_PORT}/ → 404）"
else
  bad "匿名访问入口返回 ${CODE} （多租户下期望 404）"
fi


# 7) 多租户：两个真实租户实例，各自独立 DSH_HOME / 端口 / 令牌
TENANT_API="http://127.0.0.1:$PORT/remote-connect/api/tenants"
# 用 node 解析 JSON：sed 啃 JSON 太脆
jsonq() { "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{console.log("");return}const [kind,id]=process.argv.slice(1);const t=(j.tenants||[]).find(x=>x.id===id);if(kind==="key"){const one=id?t:j.tenant;console.log(one&&one.accessKey?one.accessKey:"")}else if(kind==="port"){console.log(t&&t.port?String(t.port):"0")}else if(kind==="up"){console.log(t&&t.running===true?"1":"0")}else{console.log("")}})' "$1" "$2"; }

ADD_A="$(curl -s -b "$JAR" -H 'content-type: application/json' \
  -d '{"name":"Alice","id":"alice"}' "$TENANT_API/add")"
ADD_B="$(curl -s -b "$JAR" -H 'content-type: application/json' \
  -d '{"name":"Bob","id":"bob"}' "$TENANT_API/add")"
KEY_A="$(printf '%s' "$ADD_A" | jsonq key alice)"
KEY_B="$(printf '%s' "$ADD_B" | jsonq key bob)"
if [ -n "$KEY_A" ] && [ -n "$KEY_B" ] && [ "$KEY_A" != "$KEY_B" ]; then
  ok "多租户：两个租户已建档并各自拿到独立访问密钥"
else
  bad "多租户：新增租户失败（${ADD_A} / ${ADD_B} ）"
fi

# 等实例起来（首次启动要从模板初始化 profile，慢一些）
PORT_A=0; PORT_B=0
for _ in $(seq 1 120); do
  TLIST="$(curl -s -b "$JAR" "$TENANT_API")"
  PORT_A="$(printf '%s' "$TLIST" | jsonq port alice)"
  PORT_B="$(printf '%s' "$TLIST" | jsonq port bob)"
  if [ "$(printf '%s' "$TLIST" | jsonq up alice)" = "1" ] && [ "$(printf '%s' "$TLIST" | jsonq up bob)" = "1" ]; then break; fi
  sleep 1
done
if [ "${PORT_A:-0}" -gt 0 ] && [ "${PORT_B:-0}" -gt 0 ] && [ "$PORT_A" != "$PORT_B" ]; then
  ok "多租户：两个实例各自监听独立回环端口（${PORT_A} / ${PORT_B} ）"
else
  bad "多租户：实例端口异常（alice=${PORT_A} bob=${PORT_B} ）"
fi
if [ -d "$HOME_DIR/homes/alice/sessions" ] || [ -d "$HOME_DIR/homes/alice/profiles" ]; then
  if [ -d "$HOME_DIR/homes/bob/profiles" ]; then
    ok "多租户：租户各自拥有独立的 DSH_HOME（会话/凭据/设置互不可见）"
  else
    bad "多租户：bob 的 DSH_HOME 未初始化"
  fi
else
  bad "多租户：alice 的 DSH_HOME 未初始化"
fi

# 网关路由：A 的密钥进 A 的实例，B 的密钥进 B 的实例
GATE="http://$LAN_IP:$LAN_PORT"
JAR_A="$HOME_DIR/jar-a.txt"; JAR_B="$HOME_DIR/jar-b.txt"
CODE_A="$(curl -s -c "$JAR_A" -o /dev/null -w '%{http_code}' "$GATE/?k=$KEY_A")"
CODE_B="$(curl -s -c "$JAR_B" -o /dev/null -w '%{http_code}' "$GATE/?k=$KEY_B")"
PAGE_A="$(curl -s -b "$JAR_A" -o /dev/null -w '%{http_code}' "$GATE/")"
PAGE_B="$(curl -s -b "$JAR_B" -o /dev/null -w '%{http_code}' "$GATE/")"
if [ "$CODE_A" = "303" ] && [ "$CODE_B" = "303" ] && [ "$PAGE_A" != "401" ] && [ "$PAGE_B" != "401" ]; then
  ok "多租户：网关按密钥把人送到各自实例（A→${PAGE_A} B→${PAGE_B} ，均非 401）"
else
  bad "多租户：网关路由异常（换 Cookie A=${CODE_A}/${PAGE_A} B=${CODE_B}/${PAGE_B} ）"
fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$GATE/?k=not-a-real-key-0000")" = "404" ]; then
  ok "多租户：无效密钥 404（不暴露任何东西）"
else
  bad "多租户：无效密钥未被拒绝"
fi

# 隔离的硬证据：拿 A 实例的令牌去打 B 实例的端口，必须 401
TOK_A="$(grep -o "http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*" "$HOME_DIR/homes/alice/instance.log" 2>/dev/null | tail -1 | sed 's/.*token=//')"
if [ -z "$TOK_A" ]; then TOK_A="unknown"; fi
CROSS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_B/?token=$TOK_A" || true)"
SELF="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_A/?token=$TOK_A" || true)"
if [ "$CROSS" = "401" ]; then
  ok "多租户：把一个租户的令牌拿到另一个实例上被拒（401）—— 进程级隔离成立"
else
  bad "多租户：交叉令牌没有被拒绝（cross=${CROSS} self=${SELF} ）"
fi


# 8) CLI 路径：`dsh-remote serve --multi` 自己当网关 + 实例看护
CLI_PORT="${CLI_PORT:-8892}"
CLI_REG="$HOME_DIR/cli-tenants.json"
CLI_HOMES="$HOME_DIR/cli-homes"
CLI_LOG="$HOME_DIR/cli-serve.log"
DSH_HOME="$HOME_DIR" "$NODE" "$REPO/bin/dsh-remote.js" tenant add --name "Carol" \
  --registry "$CLI_REG" --base-dir "$CLI_HOMES" > "$HOME_DIR/cli-add.log" 2>&1
KEY_C="$(DSH_HOME="$HOME_DIR" "$NODE" "$REPO/bin/dsh-remote.js" tenant key --id carol --registry "$CLI_REG")"
if [ -n "$KEY_C" ]; then
  ok "CLI：tenant add/key 能创建租户并取回密钥"
else
  bad "CLI：tenant add 失败（$(head -2 "$HOME_DIR/cli-add.log" | tr '\n' ' ')）"
fi
DSH_HOME="$HOME_DIR" "$NODE" "$REPO/bin/dsh-remote.js" serve --multi --port "$CLI_PORT" \
  --registry "$CLI_REG" --base-dir "$CLI_HOMES" --harness-bin "$DSH" --node "$NODE" \
  > "$CLI_LOG" 2>&1 &
CLI_PID=$!
for _ in $(seq 1 90); do
  grep -q '的入口：' "$CLI_LOG" 2>/dev/null && break
  sleep 1
done
GATE_C="http://127.0.0.1:$CLI_PORT"
CLI_CODE="$(curl -s -c "$HOME_DIR/jar-c.txt" -o /dev/null -w '%{http_code}' "$GATE_C/?k=$KEY_C" || true)"
CLI_PAGE="$(curl -s -b "$HOME_DIR/jar-c.txt" -o /dev/null -w '%{http_code}' "$GATE_C/" || true)"
if [ "$CLI_CODE" = "303" ] && [ "$CLI_PAGE" != "401" ] && [ "$CLI_PAGE" != "000" ]; then
  ok "CLI：serve --multi 按密钥把人送进他自己的实例（换 Cookie=${CLI_CODE} 页面=${CLI_PAGE} ）"
else
  bad "CLI：serve --multi 路由异常（换 Cookie=${CLI_CODE} 页面=${CLI_PAGE} ）"
fi
CLI_ANON="$(curl -s -o /dev/null -w '%{http_code}' "$GATE_C/" || true)"
if [ "$CLI_ANON" = "404" ]; then
  ok "CLI：多租户网关对匿名请求返回 404"
else
  bad "CLI：匿名请求返回 ${CLI_ANON} （期望 404）"
fi
kill "$CLI_PID" 2>/dev/null; wait "$CLI_PID" 2>/dev/null
sleep 1
if lsof -nP -iTCP:"$CLI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  bad "CLI：进程退出后网关端口仍被占用"
else
  ok "CLI：退出时网关与租户实例都被回收"
fi

echo
echo "$passed 项通过，$failed 项失败"
[ "$failed" -eq 0 ]
