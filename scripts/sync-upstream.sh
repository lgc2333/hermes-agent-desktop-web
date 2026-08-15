#!/usr/bin/env bash
# sync-upstream.sh — 上游同步工作流（subtree merge, 过滤提交法）
#
# 用法:
#   bash scripts/sync-upstream.sh              # 追 main（默认）
#   bash scripts/sync-upstream.sh v0.18.0      # 追 tag（$1）
#
# 原理（见 PATCHES.md §2/§3）: 上游是 monorepo，直接 subtree pull 会把整个仓库
# 挂到 prefix 下。本脚本先对 apps/desktop 与 apps/shared 各自造"过滤提交"
# （树 = 该路径的树），再对过滤提交执行 git subtree merge --squash。
# 结果与上游对应路径逐字节一致，且 git-subtree-split 可本地解析。

set -euo pipefail

REF="${1:-main}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> git fetch upstream $REF"
git fetch upstream "$REF"

FETCH_HEAD="$(git rev-parse FETCH_HEAD)"
echo "==> upstream commit: $FETCH_HEAD"

for pair in \
  "vendor/hermes-desktop apps/desktop" \
  "vendor/hermes-shared apps/shared"
do
  set -- $pair
  PREFIX="$1"
  SUBPATH="$2"

  echo "==> $PREFIX <- upstream $SUBPATH @ $FETCH_HEAD"

  # 取该路径在 FETCH_HEAD 的树
  TREE="$(git rev-parse "FETCH_HEAD:$SUBPATH")"

  # 造过滤提交
  FILTERED="$(git commit-tree "$TREE" -m "$PREFIX subtree source: upstream $SUBPATH @ $FETCH_HEAD")"
  echo "    filtered commit: $FILTERED"

  # subtree merge --squash
  git subtree merge --prefix="$PREFIX" "$FILTERED" --squash
  echo "    merged OK"
done

echo ""
echo "==> 同步完成。请手动："
echo "    1) 更新 PATCHES.md §1 基准 SHA 为 $FETCH_HEAD"
echo "    2) pnpm install && pnpm --filter @hermes-web/web typecheck"
echo "    3) 检查冲突并按 PATCHES.md §4 登记原位改动"
