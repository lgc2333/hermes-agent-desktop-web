#!/usr/bin/env bash
# sync-upstream.sh — 上游同步工作流（subtree merge, 过滤提交法）
#
# 用法:
#   bash scripts/sync-upstream.sh              # 追 main（默认）
#   bash scripts/sync-upstream.sh v0.18.0      # 追 tag（$1）
#
# fetch 一律 --depth=1（浅取单提交及其完整树）：上游 hermes 是 monorepo 且 commit
# 极多，全量 fetch 会把整个仓库对象灌进本地导致膨胀；本地 vendor 是 squash 的，
# 只需要目标提交的 apps/desktop|shared 两棵子树，不需要上游历史（见 PATCHES.md §3）。
#
# 原理（见 PATCHES.md §2/§3）: 上游是 monorepo，直接 subtree pull 会把整个仓库
# 挂到 prefix 下。本脚本先对 apps/desktop 与 apps/shared 各自造"过滤提交"
# （树 = 该路径的树），再对过滤提交执行 git subtree merge --squash。
# 结果与上游对应路径逐字节一致，且 git-subtree-split 可本地解析。

set -euo pipefail

REF="${1:-main}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> 清理上游 tracking refs（浅取边界防坑，见 PATCHES.md §8）"
# 陈旧 upstream/* tracking ref 链上对象可能已缺失，fetch 会报 'Could not read'；
# 本脚本只用 FETCH_HEAD，每次先删掉避免累积缺失对象链。
git for-each-ref refs/remotes/upstream/ --format='%(refname)' | while read r; do
  git update-ref -d "$r"
done

echo "==> git fetch --depth=1 upstream $REF"
git fetch upstream --depth=1 "$REF"

# 浅取时 FETCH_HEAD 对 tag 是 tag 对象；peel 到 commit，后续 :path 取树才可用。
FETCH_HEAD="$(git rev-parse FETCH_HEAD^{commit})"
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

  # 挂 ref 保护：过滤提交不挂任何 ref、只被 squash message 引用，git gc（含普通 gc，
  # 2 周 grace 后）会回收它，subtree merge 将 fatal（PATCHES.md §3）。ref 名取子树名。
  ANCHOR_REF="refs/subtree-anchors/${PREFIX##*/}"
  git update-ref "$ANCHOR_REF" "$FILTERED"
  echo "    anchored: $ANCHOR_REF"

  # subtree merge --squash
  git subtree merge --prefix="$PREFIX" "$FILTERED" --squash
  echo "    merged OK"
done

echo ""
echo "==> 同步完成。请手动："
echo "    1) 更新 PATCHES.md §1 基准 SHA 为 $FETCH_HEAD"
echo "    2) pnpm install && pnpm --filter @hermes-web/web typecheck"
echo "    3) 检查冲突并按 PATCHES.md §4 登记原位改动"
echo "    4) 清理：浅取给本地留了 shallow 边界与上游 tag 引用（squash 后不需要，"
echo "       留着会使仓库保持 shallow 且体积膨胀）。完事后："
echo "          git update-ref -d refs/tags/$REF; rm -f .git/shallow; git gc"
echo "       注意：过滤提交已由 refs/subtree-anchors/ 保护，任何 gc 都不会回收；"
echo "       若将来 ref 丢失，gc 会回收 split 对象导致 subtree merge fatal（PATCHES.md §3）。"
