#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="--execute"

if [[ "${1:-}" == "--plan" ]]; then
  mode=""
  shift
fi

commit_message="${1:-}"
if [[ -z "$commit_message" ]]; then
  echo "usage: npm run release:checked -- [--plan] 'type: commit message'" >&2
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
exec "$publisher" "${args[@]}"
