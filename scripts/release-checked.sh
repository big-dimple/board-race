#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="--execute"
wait_pages=1

while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --plan) mode="" ;;
    --no-wait-pages) wait_pages=0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

commit_message="${1:-}"
if [[ -z "$commit_message" ]]; then
  echo "usage: npm run release:checked -- [--plan] [--no-wait-pages] 'type: commit message'" >&2
  exit 2
fi
if [[ $# -gt 1 ]]; then
  echo "commit message must be supplied as one quoted argument" >&2
  exit 2
fi

publisher="${PUBLISH_CHECKED_SH:-}"
if [[ -z "$publisher" ]]; then
  for candidate in \
    "${CODEX_HOME:-$HOME/.codex}/skills/github-operator/scripts/publish-checked.sh" \
    "$HOME/.codex/skills/github-operator/scripts/publish-checked.sh"; do
    if [[ -x "$candidate" ]]; then
      publisher="$candidate"
      break
    fi
  done
fi

if [[ -z "$publisher" && -d /mnt/c/Users ]]; then
  publisher="$(find /mnt/c/Users -maxdepth 6 -type f -path '*/.codex/skills/github-operator/scripts/publish-checked.sh' -print -quit 2>/dev/null || true)"
fi

if [[ ! -x "$publisher" ]]; then
  echo "github-operator publish-checked.sh was not found; set PUBLISH_CHECKED_SH" >&2
  exit 2
fi

args=(--repo "$repo_root" --commit-message "$commit_message")
if [[ -n "$mode" ]]; then args+=("$mode"); fi

contract_copy=''
if [[ $wait_pages -eq 0 ]]; then
  command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
  contract_copy="$repo_root/.git/codex-publish-no-pages.$$.json"
  jq 'del(.pages)' "$repo_root/.github/codex-publish.json" > "$contract_copy"
  args+=(--contract "$contract_copy")
  trap 'rm -f "$contract_copy"' EXIT
fi

set +e
"$publisher" "${args[@]}"
publish_status=$?
set -e

if [[ $publish_status -eq 0 ]]; then exit 0; fi
if [[ -z "$mode" ]]; then exit "$publish_status"; fi
if [[ $wait_pages -eq 0 ]]; then exit "$publish_status"; fi

if [[ -n "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" ]]; then
  exit "$publish_status"
fi

local_sha="$(git -C "$repo_root" rev-parse HEAD)"
remote_sha="$(git -C "$repo_root" ls-remote origin refs/heads/main | awk '{print $1}')"
if [[ -z "$remote_sha" || "$local_sha" != "$remote_sha" ]]; then
  exit "$publish_status"
fi

echo "checked publisher metadata verification failed after push; trying public Pages fallback" >&2
node "$repo_root/scripts/verify-pages-fallback.mjs" "$local_sha"
