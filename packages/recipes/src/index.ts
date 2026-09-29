/**
 * @curtain/recipes — Step -> Recipe -> Combo library for private DeFi (Uniswap, Morpho, Arcus, Prism)
 * M6: Step/Recipe/Combo types + buildRelay() + the BuyAndShield recipe.
 * MorphoDeposit/MorphoWithdraw/ArcusOpen/ArcusClose/PrismDexSwap are M9
 * work (Curtain_Build.md's milestone table) — this package's shape already
 * supports them as more `Step` factories once those protocols' real
 * contracts/ABIs are integrated.
 */
export const name = "recipes" as const;

export function ready(): boolean {
  return true;
}

export * from "./types";
export * from "./erc20";
export * from "./dex";
