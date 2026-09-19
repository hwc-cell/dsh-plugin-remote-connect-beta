#!/usr/bin/env bash
# 门禁：仓库里不得出现作者私有值（自有域名 / 服务器 IP / 本机绝对路径 / 真实公钥）。
# 用法：bash test/no-private-values.sh
set -uo pipefail
cd "$(dirname "$0")/.."
# 192.168.x.x 这类占位写法不算命中（x 不是数字），真实网段地址才算
PATTERNS='lycheeledger|154\.64\.255|45\.76\.79|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|/Users/[A-Za-z0-9._-]+/|ssh-ed25519 AAAA[A-Za-z0-9+/]{20,}|mango-harbor|violet-tundra|edge[_-]?password[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{4,}'
hits="$(grep -rInE "$PATTERNS" \
  --exclude-dir=node_modules --exclude-dir=.git \
  --exclude='*.png' --exclude='*.jpg' --exclude='no-private-values.sh' \
  . || true)"
if [ -n "$hits" ]; then
  echo "✖ 命中私有值（这些不该进开源仓库）："
  echo "$hits"
  exit 1
fi
echo "✔ 未发现私有值（域名 / 服务器 IP / 本机路径 / 真实公钥）"
