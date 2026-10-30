#!/usr/bin/env bash
# ── Trader Vaults devnet deploy ────────────────────────────────────────────
# Build the vault program and deploy it to devnet, then print the
# program id to put in .env as VAULT_PROGRAM_ID.
#
# Requires a host C linker for cargo build scripts. On Windows that
# means EITHER WSL (recommended: `wsl --install`, reboot) OR Visual
# Studio Build Tools with the Windows SDK. Rust + the Solana CLI are
# already installed for you (see GO-LIVE.md).
set -euo pipefail

cd "$(dirname "$0")/../programs/vault"
export PATH="$HOME/.cargo/bin:$HOME/solana/solana-release/bin:$PATH"

echo "==> building (this takes a few minutes the first time)"
cargo-build-sbf

KEYPAIR=target/deploy/vault-keypair.json
PROGRAM_ID=$(solana-keygen pubkey "$KEYPAIR")
echo "==> program id: $PROGRAM_ID"

# The declare_id! in lib.rs must match the deployed key.
if ! grep -q "$PROGRAM_ID" programs/vault/src/lib.rs; then
  echo "!! lib.rs declare_id! does not match $PROGRAM_ID"
  echo "!! update it and rebuild before deploying."
  exit 1
fi

BAL=$(solana balance --output json 2>/dev/null | grep -o '[0-9.]*' | head -1 || echo 0)
echo "==> deployer balance: ${BAL} SOL (need ~3-5)"

echo "==> deploying to devnet"
solana program deploy \
  --program-id "$KEYPAIR" \
  --url devnet \
  target/deploy/vault.so

echo
echo "==> deployed. add this to .env:"
echo "    VAULT_PROGRAM_ID=$PROGRAM_ID"
echo "    SOLANA_CLUSTER=devnet"
