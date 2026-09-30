/**
 * Per-token uiMultiplier() records, per Curtain_Build.md §3.1's `tokens` table:
 * `(addr pk, symbol, is8056 bool, multiplier numeric, next_mult numeric, next_at)`.
 *
 * Multipliers are WAD-scaled bigints (1e18 == 1.0x), matching the fixed-point convention
 * `@curtain/recipes`' Morpho NAV calculation already uses elsewhere in this codebase.
 *
 * WHERE THE DATA COMES FROM: a real stock split/ex-div event is a corporate action
 * announced by the issuer, not something derivable from on-chain state — there is no
 * contract call this service can poll for "NVDA just did a 10:1 split." A production
 * deployment needs this store fed by a real corporate-actions data feed (a paid market-data
 * API, or manual ops entry from an announcement). This module deliberately exposes that as
 * an explicit `setMultiplier`/`scheduleMultiplier` write path rather than faking a feed —
 * wiring a specific data provider in is a follow-up once one is chosen, not a structural gap
 * in this service.
 */
export const WAD = 1_000_000_000_000_000_000n;

export interface TokenMultiplierRecord {
  address: string; // lowercased
  symbol: string;
  is8056: boolean;
  multiplier: bigint; // current, WAD-scaled
  nextMultiplier: bigint | null; // scheduled next value, WAD-scaled, or null if none pending
  effectiveAt: number | null; // unix seconds the scheduled change takes effect, or null
}

export class MultiplierStore {
  private tokens = new Map<string, TokenMultiplierRecord>();

  register(address: string, symbol: string, is8056: boolean): TokenMultiplierRecord {
    const key = address.toLowerCase();
    const existing = this.tokens.get(key);
    if (existing) return existing;
    const record: TokenMultiplierRecord = {
      address: key,
      symbol,
      is8056,
      multiplier: WAD,
      nextMultiplier: null,
      effectiveAt: null,
    };
    this.tokens.set(key, record);
    return record;
  }

  get(address: string): TokenMultiplierRecord | undefined {
    this.promoteIfDue(address.toLowerCase());
    return this.tokens.get(address.toLowerCase());
  }

  list(): TokenMultiplierRecord[] {
    for (const key of this.tokens.keys()) this.promoteIfDue(key);
    return [...this.tokens.values()];
  }

  /** Immediately sets a token's current multiplier, clearing any pending schedule. */
  setMultiplier(address: string, multiplier: bigint): TokenMultiplierRecord {
    const key = address.toLowerCase();
    const record = this.tokens.get(key);
    if (!record) throw new Error(`setMultiplier: unknown token ${address}`);
    record.multiplier = multiplier;
    record.nextMultiplier = null;
    record.effectiveAt = null;
    return record;
  }

  /**
   * Schedules a future multiplier change (e.g. a stock split announced ahead of its
   * ex-date) — per Curtain_Build.md §4's "Ex-div: nothing moves, multiplier-view updates
   * display" flow, raw note amounts never change; only the display multiplier does, and
   * only once `effectiveAt` has passed.
   */
  scheduleMultiplier(address: string, nextMultiplier: bigint, effectiveAt: number): TokenMultiplierRecord {
    const key = address.toLowerCase();
    const record = this.tokens.get(key);
    if (!record) throw new Error(`scheduleMultiplier: unknown token ${address}`);
    if (nextMultiplier <= 0n) throw new Error("scheduleMultiplier: nextMultiplier must be positive");
    record.nextMultiplier = nextMultiplier;
    record.effectiveAt = effectiveAt;
    return record;
  }

  private promoteIfDue(key: string) {
    const record = this.tokens.get(key);
    if (!record || record.nextMultiplier === null || record.effectiveAt === null) return;
    if (Date.now() / 1000 >= record.effectiveAt) {
      record.multiplier = record.nextMultiplier;
      record.nextMultiplier = null;
      record.effectiveAt = null;
    }
  }
}
