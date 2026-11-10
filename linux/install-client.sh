#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
if [[ $# != 2 ]]; then echo 'Usage: bash linux/install-client.sh INSTANCE_GAME_DIRECTORY PAIRING_JSON' >&2; exit 2; fi
instance=$(realpath -e -- "$1")
pair=$(realpath -e -- "$2")
[[ -d "$instance" && -f "$pair" ]]
node -e "const f=JSON.parse(require('fs').readFileSync(process.argv[1]));if(f.version!=='26.3'||!(/^(buyer|seller)[1-9][0-9]?$/.test(f.accountId))||!(/^[a-f0-9]{64}$/.test(f.token)))throw Error('Invalid pairing file')" "$pair"
sha256sum -c release/SHA256SUMS
mkdir -p -- "$instance/mods" "$instance/config"
install -m 0600 release/autosell-bridge-3.0.0.jar "$instance/mods/autosell-bridge-3.0.0.jar"
install -m 0600 release/fabric-api-0.165.2+26.3.jar "$instance/mods/fabric-api-0.165.2+26.3.jar"
if [[ "$pair" != "$instance/config/autosell-bridge.json" ]]; then install -m 0600 "$pair" "$instance/config/autosell-bridge.json"; fi
chmod 0600 "$instance/config/autosell-bridge.json" 
echo 'Both JARs are installed. Launch this Minecraft 26.3 instance with Fabric Loader 0.20.1.'

