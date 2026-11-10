#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
command -v node >/dev/null || { echo 'Install Node.js 24 LTS first.' >&2; exit 1; }
node -e "const [major,minor]=process.versions.node.split('.').map(Number); if(major<22||(major===22&&minor<13)) throw Error('Node.js 22.13+ or 24 LTS is required');require('node:sqlite')"
command -v npm >/dev/null || { echo 'Install npm for this Node.js runtime.' >&2; exit 1; }
npm ci --no-audit --no-fund
npx --no-install playwright install chromium
sha256sum -c release/SHA256SUMS
echo 'Installed. Run bash linux/start.sh from your graphical desktop session.'

