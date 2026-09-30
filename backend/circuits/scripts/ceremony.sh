#!/usr/bin/env bash
# Dev/test Groth16 trusted setup for Curtain's circuits. This is a SINGLE-
# CONTRIBUTOR local ceremony for development and CI — it is explicitly NOT
# the production ceremony. Curtain_Build.md §7 requires a real multi-party
# Phase-2 contribution round with a published transcript before mainnet;
# that is an M12 launch-gate activity, not something this script fakes.
set -euo pipefail

cd "$(dirname "$0")/.."
SNARKJS="bunx snarkjs"
PTAU_DIR="build/ptau"
POWER=18 # 2^18 = 262144 >= our largest circuit's ~127k constraints (ppoi)

mkdir -p "$PTAU_DIR"

echo "== Phase 1: Powers of Tau (bn128, 2^${POWER}) =="
$SNARKJS powersoftau new bn128 "$POWER" "$PTAU_DIR/pot_0000.ptau" -v
$SNARKJS powersoftau contribute "$PTAU_DIR/pot_0000.ptau" "$PTAU_DIR/pot_0001.ptau" \
  --name="Curtain dev ceremony — contribution 1 (NOT production)" -e="$(openssl rand -hex 32)" -v
$SNARKJS powersoftau prepare phase2 "$PTAU_DIR/pot_0001.ptau" "$PTAU_DIR/pot_final.ptau" -v

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

setup_circuit "joinsplit2x2"
setup_circuit "joinsplit3x3"
setup_circuit "ppoi_main"
setup_circuit "solvency_dev"

echo ""
echo "== Done. Verification keys + Solidity verifiers written under build/<circuit>/ =="
