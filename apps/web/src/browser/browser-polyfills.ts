/**
 * Sets `globalThis.Buffer` before anything else in this app's module graph evaluates.
 *
 * circomlibjs (pulled in transitively via @curtain/sdk's keys.ts/notes.ts, for
 * Poseidon/BabyJub) references Node's `Buffer` global at module-evaluation time, not just
 * inside a function body — so a plain assignment statement placed "first" in main.ts's
 * source text does NOT run early enough: per the ECMAScript module spec, ALL of a module's
 * `import` declarations (wherever they appear in the file) are resolved and fully evaluated,
 * depth-first, in declaration order, before that module's own top-level statement bodies run
 * at all. A bare assignment statement is not an import declaration, so it only runs during
 * main.ts's own body evaluation — which happens strictly after every import in main.ts
 * (including the transitive one reaching circomlibjs) has already finished evaluating.
 *
 * The fix is this file: it IS an import declaration's target, with no further dependencies
 * beyond the trivial `buffer` package, so as long as `import "./browser-polyfills"` is the
 * FIRST import declaration in main.ts, this module's assignment completes before any later
 * import declaration in main.ts (e.g. `@curtain/sdk`) begins evaluating its own subtree.
 */
import { Buffer } from "buffer";

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

// Same category of issue, same fix: circomlibjs also references Node's `process` global
// (env checks / nextTick-style scheduling) at module-evaluation time. A minimal stub is
// enough — nothing in this app's actual code path depends on real process semantics.
(globalThis as unknown as { process: Record<string, unknown> }).process ??= {
  env: {},
  browser: true,
  version: "",
  nextTick: (fn: () => void) => setTimeout(fn, 0),
};
