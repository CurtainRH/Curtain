/**
 * @curtain/status — Public status page service
 * Aggregates provider freshness, standby state (15/60 min), hourly solvency proofs, and broadcaster health.
 */

export const name = "status" as const;

export function ready(): boolean {
  return true;
}

export interface ProviderStatus {
  id: number;
  name: string;
  publisher: string;
  root: string;
  updatedAt: number;
  isStale: boolean;
}

export interface SolvencyTokenStatus {
  token: string;
  epoch: number;
  isSolvent: boolean;
  totalLiveNotes: string;
  poolBalance: string;
  timestamp: number;
}

export interface BroadcasterStatus {
  address: string;
  bondedAmount: string;
  feeBps: number;
  gasMarkupBps: number;
  isBonded: boolean;
}

export interface ProtocolStatusReport {
  timestamp: number;
  standbySeconds: number;
  isDegradedStandby: boolean;
  activeProviderCount: number;
  freshProviderCount: number;
  providers: ProviderStatus[];
  solvency: SolvencyTokenStatus[];
  broadcasters: BroadcasterStatus[];
}

const STALE_AFTER_SECONDS = 86400; // 24 hours per ScreeningGate / Backend §2.2

/**
 * Calculates protocol standby window and health status based on provider freshness.
 */
export function buildProtocolStatus(
  providers: ProviderStatus[],
  solvencyReports: SolvencyTokenStatus[],
  broadcasters: BroadcasterStatus[],
  currentTime: number = Math.floor(Date.now() / 1000)
): ProtocolStatusReport {
  let freshCount = 0;

  const processedProviders = providers.map((p) => {
    const isStale = currentTime - p.updatedAt > STALE_AFTER_SECONDS;
    if (!isStale) freshCount++;
    return { ...p, isStale };
  });

  // Standby extends to 60 min (3600s) if < 2 fresh providers; otherwise standard 15 min (900s)
  const isDegradedStandby = freshCount < 2;
  const standbySeconds = isDegradedStandby ? 3600 : 900;

  return {
    timestamp: currentTime,
    standbySeconds,
    isDegradedStandby,
    activeProviderCount: providers.length,
    freshProviderCount: freshCount,
    providers: processedProviders,
    solvency: solvencyReports,
    broadcasters,
  };
}
