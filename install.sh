#!/bin/sh
# Installs the sesh command and its Claude Code status line:
#
#   curl -fsSL https://raw.githubusercontent.com/craftmilldev/sesh/main/install.sh | sh
#
# It downloads the latest release of the CLI from GitHub to ~/.sesh/sesh.mjs, links it as `sesh` in ~/.local/bin, and runs
# `sesh setup`, which saves the server and token from your OTel export settings (the OTEL_* env vars from sesh's
# tokens page, in your shell or Claude Code's settings.json) and makes sesh Claude Code's status line. Set those up
# first, or run `sesh setup --url <server> --token <token>` afterwards. The installed CLI updates itself from
# the repo's releases; `sesh config set auto_update off` stops that. Needs Node 22+.
#
# An existing status line that isn't sesh's is only replaced if you say so (or SESH_REPLACE=1).
# Other settings: SESH_VERSION (a release to install instead of the latest), SESH_DOWNLOAD_URL (where releases are), SESH_STATE_DIR (default ~/.sesh), SESH_BIN_DIR (default ~/.local/bin),
# CLAUDE_CONFIG_DIR (default ~/.claude).

set -eu

SESH_VERSION="${SESH_VERSION:-}" # e.g. 0.1.0, to install that release instead of the latest
BASE="${SESH_DOWNLOAD_URL:-https://github.com/craftmilldev/sesh/releases}"
if [ -n "$SESH_VERSION" ]; then URL="$BASE/download/cli-v${SESH_VERSION#v}"; else URL="$BASE/latest/download"; fi
DIR="${SESH_STATE_DIR:-$HOME/.sesh}"
BIN_DIR="${SESH_BIN_DIR:-$HOME/.local/bin}"
SCRIPT="$DIR/sesh.mjs"

say() { printf '%s\n' "$*" >&2; }
die() { say "sesh: $*"; exit 1; }

command -v node >/dev/null 2>&1 || die "Node 22 or later is required (https://nodejs.org)."
NODE="$(command -v node)"
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || die "Node 22 or later is required; found $("$NODE" --version)."

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "curl or wget is required."
fi

mkdir -p "$DIR" "$BIN_DIR"
tmp="$DIR/.sesh.$$.mjs"
trap 'rm -f "$tmp"' EXIT
fetch "$URL/sesh.mjs" "$tmp" || die "could not download $URL/sesh.mjs"
# A quick check that it is the CLI and not an error page.
version="$("$NODE" "$tmp" --version 2>/dev/null)" || die "the downloaded file doesn't run under $("$NODE" --version)."
case "$version" in [0-9]*.[0-9]*.[0-9]*) ;; *) die "$URL/sesh.mjs doesn't look like the sesh CLI." ;; esac
chmod 755 "$tmp"
mv "$tmp" "$SCRIPT"
say "Installed sesh $version at $SCRIPT"

# The status line runs the file by Node's absolute path, so it needs no PATH; this link is for you.
ln -sf "$SCRIPT" "$BIN_DIR/sesh"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Note: $BIN_DIR isn't on your PATH, so add it to run \`sesh\`." ;;
esac

# With curl | sh, stdin is this script; `sesh setup` asks its one question on the terminal if it has one.
"$NODE" "$SCRIPT" setup || say "Finish with \`sesh setup\` once the OTel export is set up."
