/**
 * @curtain/recipes — Step -> Recipe -> Combo library for private DeFi (Uniswap, Morpho, Arcus, Prism)
 * M6: Step/Recipe/Combo types + buildRelay() + BuyAndShield recipe.
 * M9: MorphoDeposit/MorphoWithdraw + ArcusOpen/ArcusClose + PrismDexSwap recipes + NAV calculation helper.
 */
export const name = "recipes" as const;

export function ready(): boolean {
  return true;
}

export * from "./types";
export * from "./erc20";
export * from "./dex";
export * from "./morpho";
export * from "./arcus";
export * from "./prism";
