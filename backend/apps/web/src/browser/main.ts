/**
 * Curtain reference wallet UI — shield/balances/send/unshield against a real deployed
 * CurtainPool, proving through a real `services/prover-assist` server (never the Node-only
 * local prover — see @curtain/sdk's prover-backend.ts header for why that can't run here at
 * all). Deliberately plain (no framework, no build step beyond Vite/esbuild) to match this
 * project's existing lean style; NOT a claim that this is a polished consumer wallet.
 *
 * Explicitly out of scope for this first browser build (flagged, not silently skipped):
 * relay()/recipes (BuyAndShield etc — the SDK method is real and tested, wiring it into a
 * "pick a recipe" UI is a separate follow-up), and disclosure grants (@curtain/sdk's
 * disclosure.ts exists and is tested but has no UI here yet).
 */
import "./browser-polyfills"; // must be the first import — see its header
import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  type Address, type Hex, type EIP1193Provider,
} from "viem";
import {
  CurtainWallet, ProverAssistBackend, generateWalletKeysWithMnemonic,
  recoverWalletKeysFromMnemonic, deriveWalletKeys,
  type WalletKeys, type OwnedNote,
} from "@curtain/sdk";
// Balances below show raw note amounts only — displaying the ERC-8056 uiMultiplier()-adjusted
// value (fetchUiMultiplier/computeDisplayBalance, both real and tested — see pool-client.ts)
// needs a tokenId->token-address registry this minimal UI doesn't have yet, since OwnedNote
// only carries the derived tokenId, not the original address shield() was called with.
import { poolAbi, erc20Abi } from "./pool-abi";
import { hasStoredKeystore, saveEncryptedSeed, loadEncryptedSeed, clearKeystore, WrongPasswordError } from "./keystore";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

// ---- persisted config (addresses/URLs an operator points this build at) ----
const CONFIG_KEY = "curtain.config.v1";
interface AppConfig {
  chainId: number;
  rpcUrl: string;
  poolAddress: string;
  proverAssistUrl: string;
  multiplierViewUrl: string;
}
const DEFAULT_CONFIG: AppConfig = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  poolAddress: "",
  proverAssistUrl: "http://127.0.0.1:8787",
  multiplierViewUrl: "http://127.0.0.1:8788",
};
function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg: AppConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

let config = loadConfig();
let eoaAddress: Address | undefined;
let walletKeys: WalletKeys | undefined;
let curtainWallet: CurtainWallet | undefined;
let notes: OwnedNote[] = [];

const app = document.getElementById("app")!;

function h(tag: string, attrs: Record<string, string> = {}, children: (string | Node)[] = []): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}

function statusLine(msg: string, kind: "info" | "error" | "success" = "info") {
  const bar = document.getElementById("status")!;
  bar.textContent = msg;
  bar.className = `status status--${kind}`;
}

function getAnvilChain() {
  return defineChain({
    id: config.chainId,
    name: "curtain-chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

async function connectEoa(): Promise<void> {
  if (!window.ethereum) {
    statusLine("No injected wallet found (e.g. MetaMask) — install one to sign transactions.", "error");
    return;
  }
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
  eoaAddress = accounts[0];
  statusLine(`Connected: ${eoaAddress}`, "success");
  render();
}

function buildCurtainWallet(): CurtainWallet {
  if (!eoaAddress) throw new Error("connect an EOA wallet first");
  if (!walletKeys) throw new Error("unlock or create Curtain keys first");
  if (!config.poolAddress) throw new Error("set a CurtainPool address in Settings first");

  const chain = getAnvilChain();
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: custom(window.ethereum!), account: eoaAddress });

  return new CurtainWallet({
    publicClient, walletClient, account: eoaAddress,
    poolAddress: config.poolAddress as Address, poolAbi: poolAbi as never,
    keys: walletKeys,
    joinsplit2x2: { wasm: "", zkey: "" }, // unused — proverBackend below overrides both circuits
    unshield: { wasm: "", zkey: "" },
    proverBackend: new ProverAssistBackend(config.proverAssistUrl),
  });
}

async function generateNewWallet(password: string): Promise<void> {
  const { seed, mnemonic, keys } = await generateWalletKeysWithMnemonic();
  saveEncryptedSeed(seed, password);
  walletKeys = keys;
  statusLine("New wallet created. WRITE DOWN YOUR RECOVERY PHRASE NOW — it will not be shown again.", "success");
  showMnemonicOnce(mnemonic);
  render();
}

async function importWallet(mnemonic: string, password: string): Promise<void> {
  const { seed, keys } = await recoverWalletKeysFromMnemonic(mnemonic);
  saveEncryptedSeed(seed, password);
  walletKeys = keys;
  statusLine("Wallet imported and encrypted with your password.", "success");
  render();
}

async function unlockWallet(password: string): Promise<void> {
  try {
    const seed = loadEncryptedSeed(password);
    walletKeys = await deriveWalletKeys(seed);
    statusLine("Wallet unlocked.", "success");
    render();
  } catch (e) {
    if (e instanceof WrongPasswordError) statusLine("Wrong password.", "error");
    else statusLine(String(e), "error");
  }
}

function lockWallet(): void {
  walletKeys = undefined;
  curtainWallet = undefined;
  notes = [];
  statusLine("Wallet locked.", "info");
  render();
}

function showMnemonicOnce(mnemonic: string): void {
  const overlay = h("div", { class: "overlay" }, [
    h("div", { class: "overlay__box" }, [
      h("h3", {}, ["Your recovery phrase"]),
      h("p", {}, ["Write this down and store it somewhere safe. Anyone with these words controls every note this wallet ever holds."]),
      h("code", { class: "mnemonic" }, [mnemonic]),
      (() => {
        const btn = h("button", {}, ["I've saved it"]) as HTMLButtonElement;
        btn.onclick = () => overlay.remove();
        return btn;
      })(),
    ]),
  ]);
  document.body.append(overlay);
}

async function doShield(token: string, amount: string): Promise<void> {
  try {
    curtainWallet ??= buildCurtainWallet();
    statusLine("Shielding… waiting for confirmation.", "info");
    const note = await curtainWallet.shield(token as Address, BigInt(amount));
    statusLine(`Shielded. Commit ${note.commit.toString(16).slice(0, 10)}… (leaf ${note.leafIndex}). Mark it cleared once PPOI clears it.`, "success");
    await doSync();
  } catch (e) {
    statusLine(`Shield failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function doMarkCleared(commit: bigint): Promise<void> {
  try {
    curtainWallet ??= buildCurtainWallet();
    await curtainWallet.markCleared(commit);
    statusLine("Marked cleared.", "success");
    await doSync();
  } catch (e) {
    statusLine(`markCleared failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function doUnshieldToOrigin(token: string, note: OwnedNote): Promise<void> {
  try {
    curtainWallet ??= buildCurtainWallet();
    statusLine("Generating proof via prover-assist and submitting…", "info");
    await curtainWallet.unshieldToOrigin(token as Address, note);
    statusLine("Unshielded to origin.", "success");
    await doSync();
  } catch (e) {
    statusLine(`unshieldToOrigin failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function doSync(): Promise<void> {
  try {
    curtainWallet ??= buildCurtainWallet();
    statusLine("Syncing notes…", "info");
    notes = await curtainWallet.sync();
    statusLine(`Synced. ${notes.length} note(s) found.`, "success");
    render();
  } catch (e) {
    statusLine(`Sync failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

function walletSection(): HTMLElement {
  if (walletKeys) {
    return h("section", { class: "card" }, [
      h("h2", {}, ["Curtain keys"]),
      h("p", {}, [`Spending pubkey X: ${walletKeys.pkX.toString(16).slice(0, 16)}…`]),
      (() => {
        const btn = h("button", {}, ["Lock wallet"]) as HTMLButtonElement;
        btn.onclick = lockWallet;
        return btn;
      })(),
    ]);
  }

  const passwordInput = h("input", { type: "password", placeholder: "Password", id: "pw" }) as HTMLInputElement;
  const mnemonicInput = h("textarea", { placeholder: "24-word recovery phrase", id: "mnemonic-in" }) as HTMLTextAreaElement;

  const generateBtn = h("button", {}, ["Generate new wallet"]) as HTMLButtonElement;
  generateBtn.onclick = () => passwordInput.value && generateNewWallet(passwordInput.value);

  const importBtn = h("button", {}, ["Import from phrase"]) as HTMLButtonElement;
  importBtn.onclick = () => passwordInput.value && mnemonicInput.value && importWallet(mnemonicInput.value, passwordInput.value);

  const children: (string | Node)[] = [h("h2", {}, ["Curtain keys"])];
  if (hasStoredKeystore()) {
    const unlockBtn = h("button", {}, ["Unlock"]) as HTMLButtonElement;
    unlockBtn.onclick = () => passwordInput.value && unlockWallet(passwordInput.value);
    const forgetBtn = h("button", { class: "danger" }, ["Forget this wallet"]) as HTMLButtonElement;
    forgetBtn.onclick = () => { clearKeystore(); render(); };
    children.push(h("p", {}, ["A saved wallet exists in this browser."]), passwordInput, unlockBtn, forgetBtn);
  } else {
    children.push(
      h("p", {}, ["No wallet saved in this browser yet."]),
      passwordInput, generateBtn,
      h("hr", {}),
      h("p", {}, ["...or import an existing one:"]),
      mnemonicInput, importBtn,
    );
  }
  return h("section", { class: "card" }, children);
}

function settingsSection(): HTMLElement {
  const fields: [keyof AppConfig, string][] = [
    ["rpcUrl", "RPC URL"], ["chainId", "Chain ID"], ["poolAddress", "CurtainPool address"],
    ["proverAssistUrl", "prover-assist URL"], ["multiplierViewUrl", "multiplier-view URL"],
  ];
  const inputs: HTMLInputElement[] = fields.map(([key, label]) => {
    const input = h("input", { value: String(config[key]), "data-key": key }) as HTMLInputElement;
    return input;
  });
  const saveBtn = h("button", {}, ["Save settings"]) as HTMLButtonElement;
  saveBtn.onclick = () => {
    const next = { ...config };
    for (const input of inputs) {
      const key = input.dataset.key as keyof AppConfig;
      (next as Record<string, string | number>)[key] = key === "chainId" ? Number(input.value) : input.value;
    }
    config = next;
    saveConfig(config);
    curtainWallet = undefined; // rebuild against new config next use
    statusLine("Settings saved.", "success");
  };

  const rows = fields.map(([, label], i) => h("label", {}, [label, inputs[i]!]));
  return h("section", { class: "card" }, [h("h2", {}, ["Settings"]), ...rows, saveBtn]);
}

function eoaSection(): HTMLElement {
  if (eoaAddress) return h("section", { class: "card" }, [h("p", {}, [`Connected EOA: ${eoaAddress}`])]);
  const btn = h("button", {}, ["Connect wallet (MetaMask, etc.)"]) as HTMLButtonElement;
  btn.onclick = connectEoa;
  return h("section", { class: "card" }, [btn]);
}

function shieldSection(): HTMLElement {
  const tokenInput = h("input", { placeholder: "Token address (0x...)" }) as HTMLInputElement;
  const amountInput = h("input", { placeholder: "Raw amount (wei-style integer)" }) as HTMLInputElement;
  const btn = h("button", {}, ["Shield"]) as HTMLButtonElement;
  btn.onclick = () => tokenInput.value && amountInput.value && doShield(tokenInput.value, amountInput.value);
  return h("section", { class: "card" }, [h("h2", {}, ["Shield"]), tokenInput, amountInput, btn]);
}

function balancesSection(): HTMLElement {
  const syncBtn = h("button", {}, ["Sync"]) as HTMLButtonElement;
  syncBtn.onclick = doSync;

  const rows = notes.map((note) => {
    const cleared = note.clearedLeafIndex !== undefined;
    const unshieldBtn = h("button", {}, ["Unshield to origin"]) as HTMLButtonElement;
    const tokenPrompt = () => prompt("Token address for this note:") ?? "";
    unshieldBtn.onclick = () => {
      const token = tokenPrompt();
      if (token) doUnshieldToOrigin(token, note);
    };
    const clearBtn = h("button", {}, ["Mark cleared"]) as HTMLButtonElement;
    clearBtn.onclick = () => doMarkCleared(note.commit);

    return h("div", { class: "note-row" }, [
      h("span", {}, [`tokenId ${note.tokenId.toString(16).slice(0, 10)}… amount ${note.rawAmount.toString()} ${cleared ? "(cleared)" : "(pending)"}`]),
      cleared ? "" : clearBtn,
      unshieldBtn,
    ]);
  });

  return h("section", { class: "card" }, [h("h2", {}, ["Balances"]), syncBtn, ...(rows.length ? rows : [h("p", {}, ["No notes found yet — shield something, then Sync."])])]);
}

function render(): void {
  app.innerHTML = "";
  app.append(
    h("h1", {}, ["Curtain Wallet"]),
    h("div", { id: "status", class: "status" }),
    settingsSection(),
    eoaSection(),
    walletSection(),
    ...(walletKeys ? [shieldSection(), balancesSection()] : []),
  );
}

render();
