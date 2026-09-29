#!/usr/bin/env bash
# Re-runs Phase 2 for joinsplit2x2/joinsplit3x3 after M4 added the
# clearedRoot membership check. Reuses pot_final.ptau (both circuits still
# fit comfortably under 2^18 constraints — see the printed counts before
# this script ran).
set -euo pipefail
cd "$(dirname "$0")/.."
SNARKJS="bunx snarkjs"
PTAU_DIR="build/ptau"

setup_circuit() {
  local name="$1"
  local dir="build/$name"
  echo ""
  echo "== Phase 2: $name (M4: clearedRoot added) =="
  $SNARKJS groth16 setup "$dir/$name.r1cs" "$PTAU_DIR/pot_final.ptau" "$dir/${name}_0000.zkey"
  $SNARKJS zkey contribute "$dir/${name}_0000.zkey" "$dir/${name}_final.zkey" \
    --name="Curtain dev ceremony — $name contribution 1 (M4, NOT production)" -e="$(openssl rand -hex 32)" -v
  $SNARKJS zkey export verificationkey "$dir/${name}_final.zkey" "$dir/verification_key.json"
  $SNARKJS zkey export solidityverifier "$dir/${name}_final.zkey" "$dir/Verifier.sol"
}

setup_circuit "joinsplit2x2"
setup_circuit "joinsplit3x3"

echo ""
echo "== Done =="
