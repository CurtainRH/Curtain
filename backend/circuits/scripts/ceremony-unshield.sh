#!/usr/bin/env bash
# Phase 2 setup for the new `unshield` circuit (see Curtain_Build.md §11
# item 10 and unshield.circom's header — closes a double-spend gap found
# while building M5). Reuses pot_final.ptau (4,638 total constraints,
# comfortably under 2^18).
set -euo pipefail
cd "$(dirname "$0")/.."
SNARKJS="bunx snarkjs"
PTAU_DIR="build/ptau"

setup_circuit() {
  local name="$1"
  local dir="build/$name"
  echo ""
  echo "== Phase 2: $name (M5 fix, NOT production) =="
  $SNARKJS groth16 setup "$dir/$name.r1cs" "$PTAU_DIR/pot_final.ptau" "$dir/${name}_0000.zkey"
  $SNARKJS zkey contribute "$dir/${name}_0000.zkey" "$dir/${name}_final.zkey" \
    --name="Curtain dev ceremony — $name contribution 1 (M5 fix, NOT production)" -e="$(openssl rand -hex 32)" -v
  $SNARKJS zkey export verificationkey "$dir/${name}_final.zkey" "$dir/verification_key.json"
  $SNARKJS zkey export solidityverifier "$dir/${name}_final.zkey" "$dir/Verifier.sol"
}

setup_circuit "unshield"

echo ""
echo "== Done =="
