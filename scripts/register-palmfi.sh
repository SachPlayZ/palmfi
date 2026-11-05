#!/usr/bin/env bash
# Register palmfi.eth on Sepolia via ENSv2 ETHRegistrar (commit/reveal, pays MockUSDC).
# Usage: scripts/register-palmfi.sh [keystore-account]   (default: "default")
# Addresses: docs/research/ensv2.md §5 (2026-10-01 Sepolia set).
set -euo pipefail

ACCOUNT="${1:-default}"
export ETH_RPC_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
REGISTRAR=0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3
USDC=0x240b0316df57887dbbe58b586508b19e633a14aa
LABEL=palmfi
DURATION=157680000 # 5y
ZERO=0x0000000000000000000000000000000000000000
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000

# password via temp file, passed only to signing commands (exported ETH_PASSWORD breaks `cast call`)
PWFILE=$(mktemp); chmod 600 "$PWFILE"; trap 'rm -f "$PWFILE"' EXIT
read -rsp "Keystore password for '$ACCOUNT': " PW; echo
printf '%s' "$PW" > "$PWFILE"; unset PW
send() { cast send --account "$ACCOUNT" --password-file "$PWFILE" "$@"; }
OWNER=$(cast wallet address --account "$ACCOUNT" --password-file "$PWFILE")
echo "owner: $OWNER  balance: $(cast balance "$OWNER" --ether) ETH"

[ "$(cast call $REGISTRAR 'isAvailable(string)(bool)' $LABEL)" = true ] || { echo "$LABEL.eth not available"; exit 1; }

PRICE=$(cast call $REGISTRAR 'getRegisterPrice(string,uint64,address)(uint256,uint256)' $LABEL $DURATION $USDC | awk 'NR==1{b=$1} NR==2{p=$1} END{print b+p}')
echo "price: $PRICE MockUSDC base units"

send $USDC 'mint(address,uint256)' "$OWNER" $((PRICE * 2)) >/dev/null
send $USDC 'approve(address,uint256)' $REGISTRAR $((PRICE * 2)) >/dev/null
echo "minted + approved"

SECRET=0x$(openssl rand -hex 32)
# subregistry + resolver left empty: parent resolver must stay empty (ensv2.md TL;DR 6)
HASH=$(cast call $REGISTRAR 'makeCommitment(string,address,bytes32,address,address,uint64,bytes32)(bytes32)' \
  $LABEL "$OWNER" "$SECRET" $ZERO $ZERO $DURATION $ZERO32)
send $REGISTRAR 'commit(bytes32)' "$HASH" >/dev/null
echo "committed; waiting 75s (MIN_COMMITMENT_AGE=60s)"
sleep 75

send $REGISTRAR 'register(string,address,bytes32,address,address,uint64,address,bytes32)' \
  $LABEL "$OWNER" "$SECRET" $ZERO $ZERO $DURATION $USDC $ZERO32 | grep -E 'status|transactionHash'

echo "available now: $(cast call $REGISTRAR 'isAvailable(string)(bool)' $LABEL)  (false = registered)"
