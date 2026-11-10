#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
if [[ -z "${VAULT_PASSPHRASE:-}" ]]; then
  if [[ ! -t 0 ]]; then echo 'Set VAULT_PASSPHRASE for unattended start or run in a terminal.' >&2; exit 1; fi
  read -rsp 'Vault passphrase: ' VAULT_PASSPHRASE; echo
  if [[ ! -f data/vault.enc ]]; then
    [[ ${#VAULT_PASSPHRASE} -ge 12 ]] || { echo 'Use at least 12 characters.' >&2; exit 1; }
    read -rsp 'Confirm new vault passphrase: ' confirm; echo
    [[ "$confirm" == "$VAULT_PASSPHRASE" ]] || { echo 'Passphrases differ.' >&2; exit 1; }
    unset confirm
  fi
fi
export VAULT_PASSPHRASE
exec node index.js

