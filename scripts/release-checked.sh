#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
execute=1

while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --plan) execute=0 ;;
    --no-wait-pages) ;; # Kept as a compatible no-op; releases never wait for Pages.
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

commit_message="${1:-}"
if [[ -z "$commit_message" || $# -ne 1 || "$commit_message" == *$'\n'* ]]; then
  echo "usage: npm run release:checked -- [--plan] [--no-wait-pages] 'type: message'" >&2
  exit 2
fi

branch="$(git -C "$repo_root" branch --show-current)"
[[ "$branch" == main ]] || { echo "release requires main, found: ${branch:-detached}" >&2; exit 3; }
git -C "$repo_root" remote get-url origin >/dev/null

git -C "$repo_root" diff --cached --quiet -- && {
  echo "stage the reviewed release files before publishing" >&2
  exit 3
}
git -C "$repo_root" diff --quiet -- || {
  echo "unstaged tracked changes are not allowed" >&2
  exit 3
}
[[ -z "$(git -C "$repo_root" ls-files --others --exclude-standard)" ]] || {
  echo "untracked files are not allowed" >&2
  exit 3
}
git -C "$repo_root" diff --cached --check

echo "repository=$repo_root"
echo "branch=$branch"
echo "gates=build,smoke"
if [[ $execute -eq 0 ]]; then
  echo "mode=plan"
  exit 0
fi

index_before="$(git -C "$repo_root" write-tree)"
(cd "$repo_root" && npm run build && npm run verify:smoke)
git -C "$repo_root" diff --quiet -- || {
  echo "a release gate changed tracked files" >&2
  exit 3
}
[[ -z "$(git -C "$repo_root" ls-files --others --exclude-standard)" ]] || {
  echo "a release gate created untracked files" >&2
  exit 3
}
[[ "$index_before" == "$(git -C "$repo_root" write-tree)" ]] || {
  echo "a release gate changed the staged file set" >&2
  exit 3
}

git -C "$repo_root" commit -m "$commit_message"
git -C "$repo_root" push origin main
echo "release=committed-and-pushed"
