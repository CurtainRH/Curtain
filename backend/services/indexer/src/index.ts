/**
 * @curtain/indexer — chain -> Postgres indexer for public aggregates. See indexer.ts.
 */
export const name = "indexer" as const;

export function ready(): boolean {
  return true;
}

export * from "./indexer";
