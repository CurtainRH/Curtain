/**
 * @curtain/ppoi-node — provider list trees, root publishing, automatic flagging of listed
 * origins, non-membership witnesses, and opt-in PPOI proving. See node.ts.
 */
export const name = "ppoi-node" as const;

export function ready(): boolean {
  return true;
}

export * from "./trees";
export * from "./node";
export * from "./server";
