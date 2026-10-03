#!/usr/bin/env bash
# 门禁：仓库里不得出现作者私有值（自有域名 / 服务器 IP / 本机绝对路径 / 真实公钥）。
# 用法：bash test/no-private-values.sh
#
# 唯一的豁免：**官方出口域名** `dsh.lycheeledger.cn`。
# 它是产品默认出口（lib/core/officialExit.js），是**有意的公开端点**，性质同
# ngrok.com / trycloudflare.com —— 不是私有值。抠掉它之后再判一次，所以
# `www.lycheeledger.cn` 这类**别的**子域照旧会命中，服务器 IP / 私钥 / 本机路径也一律照抓。
set -uo pipefail
cd "$(dirname "$0")/.."
# 192.168.x.x 这类占位写法不算命中（x 不是数字），真实网段地址才算
PATTERNS='lycheeledger|154\.64\.255|45\.76\.79|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|/Users/[A-Za-z0-9._-]+/|ssh-ed25519 AAAA[A-Za-z0-9+/]{20,}|mango-harbor|violet-tundra|edge[_-]?password[[:space:]]*[:=][[:space:]]*[\"'"'"'][^\"'"'"']{4,}'
ALLOWED_HOST='dsh\.lycheeledger\.cn'
hits="$(grep -rInE "$PATTERNS" \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude='*.png' --exclude='*.jpg' --exclude='no-private-values.sh' \
  . || true)"
if [ -n "$hits" ]; then
  # 抠掉官方出口域名后还剩命中的，才是真泄漏
  real="$(printf '%s\n' "$hits" | sed -E "s/${ALLOWED_HOST}//g" | grep -E "$PATTERNS" || true)"
  if [ -n "$real" ]; then
    echo "✖ 命中私有值（这些不该进开源仓库）："
    echo "$real"
    exit 1
  fi
fi
echo "✔ 未发现私有值（域名 / 服务器 IP / 本机路径 / 真实公钥）"
