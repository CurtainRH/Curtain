import { useEffect, useRef } from "react";
const paths = {
  overview: "/app",
  swap: "/app/swap",
  stake: "/app/stake",
  activity: "/app/activity",
};
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown;
};
type Context = {
  registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void>;
};
// Browser automation can navigate the workspace, but cannot read private escape tickets.
export function useWorkspaceTools(section: string, navigate: (path: string) => void) {
  const current = useRef({ section, navigate });
  current.current = { section, navigate };
  useEffect(() => {
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context?.registerTool) return;
    const lifetime = new AbortController();
    const register = (tool: Tool) => {
      try {
        void Promise.resolve(context.registerTool(tool, { signal: lifetime.signal })).catch(
          () => {},
        );
      } catch {
        /* This optional browser API may be unavailable. */
      }
    };
    register({
      name: "read_curtain_workspace",
      title: "Read Curtain workspace",
      description:
        "Read the active workspace section. Private tickets and recipient details are not exposed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute(input) {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length
        )
          throw new Error("Expected an empty object.");
        return { section: current.current.section };
      },
    });
    register({
      name: "open_curtain_workspace",
      title: "Open Curtain workspace section",
      description:
        "Navigate to Overview, Swap, Stake or Activity. Does not sign or submit transactions.",
      inputSchema: {
        type: "object",
        properties: { section: { type: "string", enum: Object.keys(paths) } },
        required: ["section"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Expected a section.");
        const value = input as Record<string, unknown>;
        if (
          Object.keys(value).some((k) => k !== "section") ||
          typeof value["section"] !== "string" ||
          !Object.hasOwn(paths, value["section"])
        )
          throw new Error("Unknown workspace section.");
        const target = value["section"] as keyof typeof paths;
        current.current.navigate(paths[target]);
        return { section: target, status: "Opening" };
      },
    });
    return () => lifetime.abort();
  }, []);
}
