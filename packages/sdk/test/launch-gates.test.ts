import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// import.meta.dir (this file's own directory) rather than process.cwd(), since bun test
// may be invoked from the repo root or from this package — either way this file is always
// at packages/sdk/test/, two levels below the repo root.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const PROHIBITED_WORDS = ["mixer", "untraceable", "anonymous", "hide from"];

// These are the internal engineering-spec documents that DEFINE the blocked-words policy
// (Curtain_Overview.md §9 "What not to say", Curtain_Backend.md §7 "Copy rules") — they
// necessarily contain the words themselves to state the rule. They are never shipped as
// product copy, so scanning them would just flag the policy's own definition as violating
// itself. Every other file under docs/ (and everything under apps/) is real scannable copy.
const COPY_LINT_EXCLUDED_FILES = ["Curtain_Overview.md", "Curtain_Backend.md"];

function scanDirectory(dir: string, fileExtensions: string[]): { file: string; word: string; line: number }[] {
  const violations: { file: string; word: string; line: number }[] = [];

  function walk(currentDir: string) {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return; // directory doesn't exist — nothing to scan
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "out" || entry === "cache" || entry === "lib") {
        continue;
      }
      if (COPY_LINT_EXCLUDED_FILES.includes(entry)) continue;
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (fileExtensions.some((ext) => fullPath.endsWith(ext))) {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        lines.forEach((lineText, index) => {
          const lower = lineText.toLowerCase();
          for (const word of PROHIBITED_WORDS) {
            if (lower.includes(word)) {
              violations.push({ file: fullPath, word, line: index + 1 });
            }
          }
        });
      }
    }
  }

  walk(dir);
  return violations;
}

/**
 * Static scan for persistent-storage drivers in a service's own source. Curtain_Build.md
 * §9's Privacy CI gate requires broadcaster/ppoi/prover-assist to "store nothing
 * post-request" — a genuine DB/cache dependency showing up in their source would mean
 * someone added persistent storage without updating that guarantee.
 */
const PERSISTENT_STORAGE_PATTERNS = [
  /\bnew\s+Database\s*\(/,
  /\brequire\(["']better-sqlite3["']\)/,
  /from\s+["']better-sqlite3["']/,
  /\bnew\s+Pool\s*\(/, // pg.Pool
  /\bnew\s+Client\s*\(/, // pg.Client
  /from\s+["']pg["']/,
  /from\s+["']mongodb["']/,
  /from\s+["']ioredis["']/,
  /localStorage\./,
];

function scanForPersistentStorage(dir: string): { file: string; pattern: string }[] {
  const violations: { file: string; pattern: string }[] = [];

  function walk(currentDir: string) {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "test") continue;
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (fullPath.endsWith(".ts") || fullPath.endsWith(".cjs") || fullPath.endsWith(".js")) {
        const content = readFileSync(fullPath, "utf-8");
        for (const pattern of PERSISTENT_STORAGE_PATTERNS) {
          if (pattern.test(content)) {
            violations.push({ file: fullPath, pattern: pattern.toString() });
          }
        }
      }
    }
  }

  walk(dir);
  return violations;
}

/**
 * Every file that OWNS a temp path it wrote a plaintext witness/input to (i.e. it created
 * that path itself, via mkdtempSync or a literal .tmp-*.json join()) must also clean it up
 * (rmSync/unlinkSync) somewhere in the same file. Subprocess helpers that merely receive an
 * already-created inputPath/outputPath via argv don't own that path's lifecycle — the
 * caller that made the temp dir does — so they're deliberately excluded here; flagging them
 * would just be noise. This is the exact invariant that broke in
 * services/ppoi-node/test/clear-shield.e2e.test.ts (see Curtain_Build.md §11): it built its
 * own .tmp-ppoi-input.json/.tmp-ppoi-output.json paths, wrote real rawAmount/ownerPkX/
 * originAddr fields into them, and never removed them, leaving plaintext owner/amount data
 * sitting on disk indefinitely.
 */
function scanForUncleanedTempWrites(dir: string): { file: string }[] {
  const violations: { file: string }[] = [];

  function walk(currentDir: string) {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (fullPath.endsWith(".ts") || fullPath.endsWith(".cjs") || fullPath.endsWith(".js")) {
        const content = readFileSync(fullPath, "utf-8");
        const ownsTempPath = /\bmkdtempSync\s*\(/.test(content) || /join\([^)]*["']\.tmp-/.test(content);
        if (!ownsTempPath) continue;
        const writesTempFile = /writeFileSync\s*\(/.test(content);
        if (!writesTempFile) continue;
        const cleansUp = /\b(rmSync|unlinkSync)\s*\(/.test(content);
        if (!cleansUp) {
          violations.push({ file: fullPath });
        }
      }
    }
  }

  walk(dir);
  return violations;
}

describe("Mainnet Launch Gates (TypeScript Compliance) — Curtain_Build.md §9", () => {
  it("Copy lint: no prohibited compliance words in apps/ or docs/", () => {
    const appsViolations = scanDirectory(join(REPO_ROOT, "apps"), [".ts", ".tsx", ".js", ".jsx", ".html"]);
    const docsViolations = scanDirectory(join(REPO_ROOT, "docs"), [".md"]);
    const violations = [...appsViolations, ...docsViolations];
    if (violations.length > 0) {
      throw new Error(
        `Copy lint violations:\n${violations.map((v) => `  ${v.file}:${v.line} — "${v.word}"`).join("\n")}`,
      );
    }
    expect(violations.length).toBe(0);
  });

  it("Privacy CI: broadcaster/ppoi-node/prover-assist source carries no persistent storage driver", () => {
    const dirs = [
      join(REPO_ROOT, "services", "broadcaster", "src"),
      join(REPO_ROOT, "services", "ppoi-node", "src"),
      join(REPO_ROOT, "services", "prover-assist", "src"),
    ];
    const violations = dirs.flatMap((dir) => scanForPersistentStorage(dir));
    if (violations.length > 0) {
      throw new Error(
        `Found persistent-storage drivers where Privacy CI requires none:\n${violations
          .map((v) => `  ${v.file} matches ${v.pattern}`)
          .join("\n")}`,
      );
    }
    expect(violations.length).toBe(0);
  });

  it("Privacy CI: every temp-file witness write has a matching cleanup in the same file", () => {
    const dirs = [
      join(REPO_ROOT, "services", "broadcaster"),
      join(REPO_ROOT, "services", "ppoi-node"),
      join(REPO_ROOT, "services", "prover-assist"),
    ];
    const violations = dirs.flatMap((dir) => scanForUncleanedTempWrites(dir));
    if (violations.length > 0) {
      throw new Error(
        `Files write a temp witness/input file but never clean it up (the exact bug class ` +
          `found in ppoi-node's e2e test, see Curtain_Build.md §11):\n${violations
            .map((v) => `  ${v.file}`)
            .join("\n")}`,
      );
    }
    expect(violations.length).toBe(0);
  });

  it("Privacy CI: Bundle/BroadcasterConfig types never carry raw owner/amount fields", () => {
    const typesPath = join(REPO_ROOT, "services", "broadcaster", "src", "types.ts");
    const content = readFileSync(typesPath, "utf-8");
    // "amount" is allowed only as part of feeAmount (an opaque relay fee, not a shielded
    // note's value); a bare `owner` or standalone `amount` field would mean the bundle
    // type leaks exactly the (owner, amount) tuple this gate exists to prevent.
    const forbiddenFieldPattern = /^\s*(owner|amount)\s*[?:]/m;
    expect(forbiddenFieldPattern.test(content)).toBe(false);
  });

  it.todo(
    "Recipes: BuyAndShield + Morpho deposit end-to-end from the web wallet with a broadcaster — " +
      "blocked on the SDK wallet not yet calling RelayAdapt.relay() (Curtain_Build.md §11 item 19) " +
      "and services/broadcaster having no bundle mesh, HTTPS fallback only (§11 item 22). The " +
      "contract-layer half of this gate (buy -> deposit chained atomically in one relay() call, " +
      "zero residue) IS covered: see contracts/test/adapt/RelayAdaptM9.t.sol's " +
      "test_relay_buyAndShield_thenMorphoDeposit_endToEnd.",
  );

  it("OPSEC: .env.example declares RPC/chain/deployment config with no live secrets committed", () => {
    const envExample = readFileSync(join(REPO_ROOT, ".env.example"), "utf-8");

    // Chain/RPC endpoints must be declared but left blank in the template — a real key
    // baked into the committed example would itself be an OPSEC leak.
    for (const key of ["CHAIN_ID", "RPC_HTTP", "RPC_WS"]) {
      expect(envExample).toContain(`${key}=`);
    }
    expect(envExample).toMatch(/^RPC_HTTP=\s*$/m);
    expect(envExample).toMatch(/^RPC_WS=\s*$/m);

    // No plausible live secret material: a 64-hex-char private key, or an embedded
    // "https://...@..." URL carrying an inline API key/credential.
    expect(envExample).not.toMatch(/\b0x[0-9a-fA-F]{64}\b/);
    expect(envExample).not.toMatch(/https?:\/\/[^\s]*:[^\s@]*@/);
  });

  it("OPSEC: Deploy.s.sol's fallback deployer key is the well-known public Anvil test key, never a real secret", () => {
    // Deploy.s.sol's vm.envOr default must be Anvil's published account #0 key — anything
    // else committed as a "default" would be an actual private key checked into git.
    const deployScript = readFileSync(join(REPO_ROOT, "contracts", "script", "Deploy.s.sol"), "utf-8");
    const ANVIL_ACCOUNT_0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    expect(deployScript).toContain(ANVIL_ACCOUNT_0_KEY);
  });

  it.todo(
    "OPSEC: deployer address, domain, hosting provider, and design system are unique to Curtain — " +
      "no such declaration exists anywhere in the repo yet (no domain/hosting config, no " +
      "apps/web branding, no deployments/<chainId>.json). This is a real, currently-open gap: " +
      "Curtain_Build.md §7 step 10 and Curtain_Backend.md §2.8 describe the requirement in " +
      "prose only. Genuinely testable once a real deploy produces deployments/4663.json and " +
      "apps/web ships actual branding/hosting config — fabricating a pass here now would be " +
      "exactly the theater-test problem this rewrite exists to remove.",
  );
});
