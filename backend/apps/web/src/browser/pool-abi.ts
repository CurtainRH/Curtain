/**
 * Hand-picked CurtainPool ABI fragment — only what this app calls/watches. Kept minimal and
 * self-contained (rather than importing contracts/out/CurtainPool.sol/CurtainPool.json)
 * since a deployed dApp doesn't ship with local Foundry build artifacts, and needs to work
 * against whatever pool address the user configures without any local build output present.
 */
export const poolAbi = [
  {
    type: "function", name: "shield", stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "rawAmount", type: "uint256" },
      { name: "ownerPkX", type: "uint256" },
      { name: "blinding", type: "uint256" },
      { name: "ephemeralPk", type: "bytes" },
      { name: "ct", type: "bytes" },
    ],
    outputs: [{ name: "commit", type: "bytes32" }, { name: "leafIndex", type: "uint32" }],
  },
  {
    type: "function", name: "markCleared", stateMutability: "nonpayable",
    inputs: [{ name: "commit", type: "bytes32" }],
    outputs: [{ name: "clearedLeafIndex", type: "uint32" }],
  },
  {
    type: "function", name: "transact", stateMutability: "nonpayable",
    inputs: [{
      name: "a", type: "tuple",
      components: [
        { name: "proof", type: "bytes" },
        { name: "token", type: "address" },
        { name: "root", type: "bytes32" },
        { name: "clearedRoot", type: "bytes32" },
        { name: "nullifiers", type: "bytes32[]" },
        { name: "newCommits", type: "bytes32[]" },
        { name: "unshieldTo", type: "address" },
        { name: "unshieldAmount", type: "uint256" },
        { name: "feeAmount", type: "uint256" },
        { name: "ephemeralPks", type: "bytes[]" },
        { name: "cts", type: "bytes[]" },
        { name: "feeRecipient", type: "address" },
        { name: "extData", type: "bytes32" },
      ],
    }],
    outputs: [],
  },
  {
    type: "function", name: "unshieldToOrigin", stateMutability: "nonpayable",
    inputs: [
      { name: "commit", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "netAmount", type: "uint256" },
      { name: "ownerPkX", type: "uint256" },
      { name: "blinding", type: "uint256" },
      { name: "nullifier", type: "uint256" },
      { name: "unshieldProof", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "currentRoot", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "currentClearedRoot", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "tokenIdOf", stateMutability: "pure", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "originOf", stateMutability: "view", inputs: [{ name: "commit", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "protocolFeeFor", stateMutability: "view", inputs: [{ name: "unshieldAmount", type: "uint256" }], outputs: [{ type: "uint256" }] },
  {
    type: "event", name: "Shield",
    inputs: [
      { name: "commit", type: "bytes32", indexed: true },
      { name: "leafIndex", type: "uint32", indexed: false },
      { name: "token", type: "address", indexed: true },
      { name: "rawAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "NoteCiphertext",
    inputs: [
      { name: "commit", type: "bytes32", indexed: true },
      { name: "ephemeralPk", type: "bytes", indexed: false },
      { name: "ct", type: "bytes", indexed: false },
    ],
  },
  {
    type: "event", name: "MarkedCleared",
    inputs: [
      { name: "commit", type: "bytes32", indexed: true },
      { name: "clearedLeafIndex", type: "uint32", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
