#!/usr/bin/env bash
# 把本仓库安装到当前 DSH 的 web profile：符号链接 + cordis.patch.yml 插一行。
#
# 幂等，可重复执行；不碰 profile 的 package.json / pnpm-lock（避免打乱 DSH 自己的依赖状态）。
#
#   bash install-user-profile.sh
#   DSH_HOME=/path/to/harness bash install-user-profile.sh
#
# 装完需要重启 Harness（退出并重开 DSH Desktop）才会装载。
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}"
PROFILE="$DSH_HOME_DIR/profiles/web"
REPO="$(cd "$(dirname "$0")" && pwd)"
PKG="dsh-plugin-remote-connect-beta"
LAN_PORT="${LAN_PORT:-8787}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-}"
SSH_USER="${SSH_USER:-dshtunnel}"
SSH_KEY="${SSH_KEY:-~/.ssh/dsh_remote_tunnel}"
SSH_PORT="${SSH_PORT:-22}"

if [ ! -d "$DSH_HOME_DIR" ]; then
  echo "找不到 DSH home：$DSH_HOME_DIR" >&2
  echo "用 DSH_HOME=/path/to/harness 指定（DSH Desktop 默认是 ~/Library/Application Support/dsh-desktop/harness）" >&2
  exit 2
fi
mkdir -p "$PROFILE/node_modules"

# 1) 链接包
ln -sfn "$REPO" "$PROFILE/node_modules/$PKG"
echo "✔ 已链接：$PROFILE/node_modules/$PKG -> $REPO"

# 2) patch 行（幂等）
PATCH="$PROFILE/cordis.patch.yml"
[ -f "$PATCH" ] || printf '# Your patch layer for this dsh profile.\n[]\n' > "$PATCH"
if grep -q "$PKG" "$PATCH"; then
  echo "✔ patch 已包含 ${PKG}，跳过"
else
  cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
  # 去掉占位的空数组行，再追加 insert
  grep -v '^\[\]$' "$PATCH" > "$PATCH.tmp"
  {
    echo ""
    echo "- insert:"
    echo "    - id: $PKG"
    echo "      name: $PKG"
    echo "      config:"
    echo "        lan:"
    echo "          enabled: true"
    echo "          port: $LAN_PORT"
    if [ -n "$PUBLIC_DOMAIN" ]; then
      echo "        public:"
      echo "          enabled: false"
      echo "          domain: $PUBLIC_DOMAIN"
      echo "          port: 8788"
      echo "          tunnel: ssh"
      echo "          ssh:"
      echo "            user: $SSH_USER"
      echo "            host: $PUBLIC_DOMAIN"
      echo "            keyPath: $SSH_KEY"
      echo "            port: $SSH_PORT"
    else
      echo "        public:"
      echo "          enabled: false"
    fi
  } >> "$PATCH.tmp"
  mv "$PATCH.tmp" "$PATCH"
  echo "✔ 已写入 patch：${PATCH}（原文件已备份）"
fi

# 3) 自检：包能不能被 Node 解析到
if node -e "require.resolve('$PKG/package.json', { paths: ['$PROFILE'] })" 2>/dev/null; then
  echo "✔ 包名可从 profile 解析"
else
  echo "✖ 包名无法从 profile 解析，请检查链接" >&2
  exit 1
fi

cat <<EOF

装好了。下一步：

  1) 退出并重新打开 DSH Desktop（Harness 进程重启后才会装载新插件）
  2) 侧栏「设置」上方应出现「远程连接」，默认已开启局域网入口（:${LAN_PORT}）
  3) 点开面板可看地址/二维码、开关通道、检查服务器、复制服务器配置

不想用了：
  删掉 $PROFILE/node_modules/$PKG
  并把 $PATCH 里对应的 - insert 段删掉（备份在同目录 *.bak-*）
EOF
