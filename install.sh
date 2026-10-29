#!/bin/sh
# 安装或卸掉 codexretry。
# 默认装到 /usr/local。只给当前用户时装到家目录：PREFIX=$HOME/.local ./install.sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$(readlink -f "$0")")" && pwd)
PREFIX=${PREFIX:-/usr/local}
LIB="$PREFIX/lib/codexretry"
BIN="$PREFIX/bin/codexretry"

case "$LIB" in
  */lib/codexretry) ;;
  *)
    echo "codexretry: PREFIX 不合法：$PREFIX" >&2
    exit 1
    ;;
esac

if [ "${1:-}" = "uninstall" ]; then
  rm -f "$BIN"
  rm -rf "$LIB"
  echo "已卸掉 $BIN"
  exit 0
fi

if [ "${1:-}" != "" ]; then
  echo "用法: PREFIX=/usr/local ./install.sh [uninstall]" >&2
  exit 1
fi

cd "$ROOT"
if [ ! -x node_modules/.bin/esbuild ]; then
  npm install
fi
npm run build

mkdir -p "$LIB/src" "$PREFIX/bin"
cp -f "$ROOT/codexretry" "$LIB/codexretry"
cp -f "$ROOT/page.bundle.js" "$LIB/page.bundle.js"
cp -f "$ROOT/src/injector.ts" "$ROOT/src/launch.ts" "$ROOT/src/logic.ts" "$LIB/src/"
chmod 755 "$LIB/codexretry"
ln -sfn "$LIB/codexretry" "$BIN"
echo "已安装 $BIN"
