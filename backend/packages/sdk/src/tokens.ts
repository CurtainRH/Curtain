/**
 * Tokens Curtain supports on Robinhood Chain mainnet (4663). Addresses verified 2026-10-01
 * against docs.robinhood.com/chain/contracts and Robinhood's asset registry
 * (api.robinhood.com/rhj/assets). Logos are served by the frontend from /public/tokens.
 * There is no HOOD stock token on Robinhood Chain.
 */
import type { Address } from "viem";

export interface CurtainToken {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  logo: string;
  /** ERC-8056: balances are raw units; display = raw × uiMultiplier(). */
  stock: boolean;
}

export const ROBINHOOD_CHAIN_TOKENS: CurtainToken[] = [
  { symbol: "USDG", name: "Global Dollar", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, logo: "/tokens/usdg.png", stock: false },
  { symbol: "NVDA", name: "NVIDIA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, logo: "/tokens/nvda.svg", stock: true },
  { symbol: "TSLA", name: "Tesla", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, logo: "/tokens/tsla.svg", stock: true },
  { symbol: "SPY", name: "SPDR S&P 500 ETF", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, logo: "/tokens/spy.svg", stock: true },
  { symbol: "QQQ", name: "Invesco QQQ", address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", decimals: 18, logo: "/tokens/qqq.svg", stock: true },
];
