#!/usr/bin/env bash
# Manual 3-way vendor merge (PATCHES.md §3). git-subtree split hashes were
# pruned, so subtree merge is unavailable — use this instead.
# CHANGED patched files get a real 3-way merge (base=上一版上游原版,
# ours=HEAD patched copy, theirs=新上游); SAME patched files keep the HEAD
# copy; everything else takes the new upstream tree.
#
# 用法:
#   git fetch upstream --depth=1 main
#   bash scripts/vendor-merge-manual.sh build   # 构建树+commit，不落盘
#   bash scripts/vendor-merge-manual.sh apply   # reset --hard 落地
# 参数:  [stage] [BASE_CMT] [NEW_CMT]
#   BASE_CMT 默认 = PATCHES.md §1 记录的上一基准；NEW_CMT 默认 = FETCH_HEAD。
# 注意: shared 树也要单独核对 (git rev-parse <base>:apps/shared vs <new>:
#   apps/shared)；若变了需在 apply 前手动同步 vendor/hermes-shared。
set -euo pipefail
cd /opt/data/workspace/hermes-agent-desktop-web

STAGE="${1:-build}"
BASE_CMT="${2:-9ed4a7c0251478dc5b6c6cf34f2c06625db23783}"
NEW_CMT="${3:-$(git rev-parse FETCH_HEAD^{commit})}"
HEAD_CMT="$(git rev-parse HEAD)"
DESKTOP_TREE="$(git rev-parse "$NEW_CMT:apps/desktop")"

SAME_FILES=(
  "src/app/chat/index.tsx"
  "src/components/first-run-remote-form.tsx"
  "src/components/boot-failure-overlay.tsx"
  "src/app/hooks/use-keybinds.ts"
  "src/app/chat/hooks/use-composer-actions.ts"
  "src/lib/media.ts"
)
CHANGED_FILES=(
  "src/styles.css"
  "src/global.d.ts"
  "src/app/settings/gateway-settings.tsx"
  "src/i18n/en.ts"
  "src/i18n/zh.ts"
  "src/i18n/types.ts"
)

SCRATCH="$(mktemp)"
trap 'rm -f "$SCRATCH"' EXIT
export GIT_INDEX_FILE="$SCRATCH"

echo "==> head=$HEAD_CMT base=$BASE_CMT new=$NEW_CMT desktop_tree=$DESKTOP_TREE"
git read-tree "$HEAD_CMT"
git ls-files -z vendor/hermes-desktop | git update-index -z --force-remove --stdin
git read-tree --prefix=vendor/hermes-desktop/ "$DESKTOP_TREE"

for f in "${SAME_FILES[@]}"; do
  p="vendor/hermes-desktop/$f"
  head_sha="$(git rev-parse "HEAD:$p")"
  echo "  KEEP(HEAD)  $f"
  git update-index --cacheinfo 100644 "$head_sha" "$p"
done

TMPD="$(mktemp -d)"
trap 'rm -f "$SCRATCH"; rm -rf "$TMPD"' EXIT
for f in "${CHANGED_FILES[@]}"; do
  p="vendor/hermes-desktop/$f"
  base="$TMPD/base"; ours="$TMPD/ours"; theirs="$TMPD/theirs"; merged="$TMPD/merged"
  git show "$BASE_CMT:apps/desktop/$f" > "$base"
  git show "HEAD:$p" > "$ours"
  git show "$NEW_CMT:apps/desktop/$f" > "$theirs"
  cp "$ours" "$merged"
  git merge-file -p "$merged" "$base" "$theirs" > "$merged.out" 2>/dev/null || true
  mv "$merged.out" "$merged"
  if grep -qE '^(<<<<<<<|>>>>>>>|=======)' "$merged"; then
    echo "  !! CONFLICT in $f — review $merged"
    echo "$merged" > /tmp/vendor-conflict-path.txt
    exit 2
  fi
  blob="$(git hash-object -w "$merged")"
  echo "  3WAY(clean) $f -> $blob"
  git update-index --cacheinfo 100644 "$blob" "$p"
done

NEW_TREE="$(git write-tree)"
echo "==> new tree: $NEW_TREE"
MSGBODY="sync vendor/hermes-desktop to upstream main e624e9fde56

manual 3-way (PATCHES.md §3): git-subtree split hashes pruned. New upstream
apps/desktop tree mounted via read-tree; 6 unchanged §4 patches kept at HEAD
copies; 6 upstream-changed §4 patches (styles.css, global.d.ts,
gateway-settings.tsx, i18n en/zh/types) 3-way merged against base 9ed4a7c —
all clean. hermes-shared unchanged (base==new tree)."
NEW_CMT_OUT="$(git commit-tree "$NEW_TREE" -p "$HEAD_CMT" -m "$MSGBODY")"
echo "==> new commit: $NEW_CMT_OUT"
echo "$NEW_CMT_OUT" > /tmp/vendor-new-commit.txt

if [ "$STAGE" = "apply" ]; then
  git diff --stat "$HEAD_CMT" "$NEW_CMT_OUT" -- vendor/ | tail -40
  echo "==> applying (reset --hard to $NEW_CMT_OUT)"
  unset GIT_INDEX_FILE
  git reset --hard "$NEW_CMT_OUT"
  echo "==> applied"
fi
