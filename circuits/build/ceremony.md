# Ceremony transcript — DEV/TEST ONLY

> **This is not the production ceremony.** Curtain_Build.md §7 requires a
> real multi-party Phase-2 contribution round before mainnet, with
> independent contributors and public toxic-waste destruction. This is a
> **single-contributor local ceremony** run for development and CI, using
> `circuits/scripts/ceremony.sh` and `ceremony-resume.sh`. Anyone who ran
> these scripts knows the full toxic waste — proofs made with these keys
> must never be trusted for anything beyond local dev/testing.

## Phase 1 — Powers of Tau

- Curve: bn128 (BN254)
- Power: 18 (domain size 2¹⁸ = 262,144)
- Contributions: 1 (dev)
- Output: `build/ptau/pot_final.ptau` (not committed — regenerate via
  `scripts/ceremony.sh`, ~289MB, exceeds GitHub's file size limit)

## Phase 2 — per circuit

| Circuit | Constraints (non-linear + linear) | Ptau power used | Notes |
|---|---|---|---|
| `joinsplit2x2` | 26,076 + 20,199 = 46,275 | 18 | production parameters (depth 32) |
| `joinsplit3x3` | 38,986 + 30,297 = 69,283 | 18 | production parameters (depth 32) |
| `ppoi_dev` | 29,484 + 29,705 = 59,189 | 18 | **dev-scale**: SMT depth 32, not spec's 160 (see `ppoi_dev.circom`) |
| `solvency_dev` | 72,796 + 76,677 = 149,473 | 18 | **dev-scale**: chunkSize 4, not spec's 4096 (see `solvency.circom`) |

`ppoi_main.circom` (K=3 providers, SMT depth 160 — the actual spec target)
was compiled and measured at **264,245 total constraints**, which needs a
**2²⁰ Powers of Tau** (2¹⁸ is insufficient — confirmed by snarkjs refusing
the setup: `circuit too big for this power of tau ceremony. 264245*2 >
2**18`). Generating a 2²⁰ ptau took long enough on the dev machine used
here (2¹⁸ alone took ~50 minutes) that it was deferred rather than block
M2 — `ppoi_dev` (depth 32) is the instantiation actually proven, ceremonied,
and tested in this milestone. Scaling `ppoi_main` to depth 160 is
build-infrastructure work (bigger ptau, more powerful machine, more time),
not a circuit-logic change.

## Contribution hashes (dev, for reference only)

**joinsplit2x2** contribution hash:
```
95235b2a 67645c7a 5f4bc5e5 6e3a44ee
4ec001bc 3bbdb781 c18e6eb1 4f96c92c
067bdb2e 64c452f2 186c9302 6772d30b
581c9474 0852c4da 742fd3f0 1d8813f8
```

**joinsplit3x3** contribution hash:
```
6e261d94 281f57f7 96e5759d 5ae2b651
97ea0719 a3fe1e99 aa2a19e0 56b8dd46
822d8acf d57284ec 12caeaa6 9b973762
c34b399a fdac50c8 faa8090a c5471906
```

(ppoi_dev and solvency_dev contribution hashes weren't captured in this
run's log; regenerate via `ceremony-resume.sh` if needed for the record —
they're dev-only and get regenerated with a fresh random contribution each
run anyway.)

## Reproducing

```bash
cd circuits
bun install
circom joinsplit2x2.circom --r1cs --wasm --sym -o build/joinsplit2x2
circom joinsplit3x3.circom --r1cs --wasm --sym -o build/joinsplit3x3
circom ppoi_dev.circom --r1cs --wasm --sym -o build/ppoi_dev
circom solvency_dev.circom --r1cs --wasm --sym -o build/solvency_dev
bash scripts/ceremony.sh          # Phase 1 + Phase 2 for joinsplit2x2, joinsplit3x3
bash scripts/ceremony-resume.sh   # Phase 2 for ppoi_dev, solvency_dev (reuses the ptau)
node scripts/gen-poseidon-solidity.cjs   # regenerate on-chain Poseidon deployers
node scripts/export-verifiers.cjs        # regenerate renamed Solidity verifiers
node scripts/prove-joinsplit2x2.cjs      # proof-gen/verify vector + timing
node scripts/prove-ppoi.cjs
node scripts/prove-solvency.cjs
node scripts/export-fixture.cjs          # Foundry test fixture from the joinsplit2x2 vector
```

## M2 acceptance result

- Proof gen/verify vectors: **all 4 circuits** produced a genuine witness,
  Groth16 proof, and passing `snarkjs.groth16.verify` — see
  `build/<circuit>/test_{input,proof,public}.json`.
- wasm prover time for 2×2 (target: < 8000ms desktop): **2799ms**, measured
  by `scripts/prove-joinsplit2x2.cjs`.
