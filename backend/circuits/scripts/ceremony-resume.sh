#!/usr/bin/env bash
# Resumes Phase 2 for the circuits ceremony.sh didn't reach (ppoi_main,
# solvency_dev), reusing the already-generated pot_final.ptau.
set -euo pipefail
cd "$(dirname "$0")/.."
SNARKJS="bunx snarkjs"
PTAU_DIR="build/ptau"

setup_circuit() {
  local name="$1"
  local dir="build/$name"
  echo ""
  echo "== Phase 2: $name =="
  $SNARKJS groth16 setup "$dir/$name.r1cs" "$PTAU_DIR/pot_final.ptau" "$dir/${name}_0000.zkey"
  $SNARKJS zkey contribute "$dir/${name}_0000.zkey" "$dir/${name}_final.zkey" \
    --name="Curtain dev ceremony — $name contribution 1 (NOT production)" -e="$(openssl rand -hex 32)" -v
  $SNARKJS zkey export verificationkey "$dir/${name}_final.zkey" "$dir/verification_key.json"
  $SNARKJS zkey export solidityverifier "$dir/${name}_final.zkey" "$dir/Verifier.sol"
}

setup_circuit "ppoi_dev"
setup_circuit "solvency_dev"

echo ""
echo "== Done =="
