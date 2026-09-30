/**
 * Step -> Recipe -> Combo shapes, per Curtain_Build.md §4.4. A Recipe
 * composes into the `calls`/`targets`/`outputs` shape RelayAdapt.relay()
 * needs (see contracts/src/adapt/RelayAdapt.sol) — but stops short of
 * building the actual ReshieldOutput entries (ownerPkX/blinding/
 * ephemeralPk/ct), since that's note cryptography (the wallet's job, via
 * @curtain/sdk's encryptNoteTo), not DeFi step composition. A recipe only
 * says WHICH calls to make and what minimum output to expect; the wallet
 * decides HOW to encode the resulting note.
 */
import type { Address, Hex } from "viem";

export interface TokenAmount {
  token: Address;
  amount: bigint;
}

export interface TokenSpec {
  token: Address;
  minOut: bigint;
}

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

export interface StepContext {
  /** Calls already queued by earlier steps in this recipe — later steps can read but not mutate them. */
  callsSoFar: readonly Call[];
}

export interface Step {
  name: string;
  inputs: TokenAmount[];
  call: (ctx: StepContext) => Call[];
  outputs: TokenSpec[];
}

export interface Recipe {
  id: string;
  version: string;
  steps: Step[];
  /** Every `to` address any step's calls touch — must all be allowlisted on RelayAdapt (see its `allowedTarget`). */
  targets: Address[];
}

export interface Combo {
  recipes: Recipe[];
}

export interface RelayBundle {
  calls: Call[];
  targets: Address[];
  /** Aggregated minOut per output token across every step — one entry per token the recipe expects to produce. */
  outputs: TokenSpec[];
}

/** Flattens a Recipe's steps into the calls/targets/outputs shape RelayAdapt.relay() (via the wallet) consumes. */
export function buildRelay(recipe: Recipe): RelayBundle {
  const calls: Call[] = [];
  for (const step of recipe.steps) {
    const ctx: StepContext = { callsSoFar: calls };
    calls.push(...step.call(ctx));
  }
  const outputs = recipe.steps.flatMap((step) => step.outputs);
  return { calls, targets: recipe.targets, outputs };
}

/** Runs every recipe in a Combo through buildRelay() and concatenates the results into one bundle. */
export function buildComboRelay(combo: Combo): RelayBundle {
  const calls: Call[] = [];
  const targets: Address[] = [];
  const outputs: TokenSpec[] = [];
  for (const recipe of combo.recipes) {
    const bundle = buildRelay(recipe);
    calls.push(...bundle.calls);
    targets.push(...bundle.targets);
    outputs.push(...bundle.outputs);
  }
  return { calls, targets, outputs };
}
