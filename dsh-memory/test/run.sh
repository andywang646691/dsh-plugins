#!/usr/bin/env bash
# Unit tests. Resolves DSH peer deps from the installed DSH app via NODE_PATH-free symlinks
# placed in a throwaway dir, so the plugin's own tree stays clean for pnpm link installs.
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/node_modules/@deepseek-ai"
ln -s /opt/dsh/app/node_modules/yaml "$T/node_modules/yaml"
ln -s /opt/dsh/app/node_modules/@deepseek-ai/dsh-tools "$T/node_modules/@deepseek-ai/dsh-tools"
cp -r lib test package.json "$T/"
cd "$T" && node --test test/*.test.js
