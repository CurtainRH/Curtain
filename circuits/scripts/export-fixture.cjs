// Converts the joinsplit2x2 test proof/public signals into a clean JSON
// fixture for Foundry's CurtainPool integration test — using snarkjs's own
// exportSolidityCallData output as the source of truth for (a,b,c) ordering
// rather than hand-deriving it from pi_a/pi_b/pi_c (the pairing check's b
// coordinate order is easy to get backwards by hand).
const path = require("path");
const fs = require("fs");

const buildDir = path.resolve(__dirname, "../build/joinsplit2x2");
const calldata = fs.readFileSync(path.join(buildDir, "test_calldata.txt"), "utf-8");

// calldata is literally: [a0,a1],[[b00,b01],[b10,b11]],[c0,c1],[pub0,...,pub9]
const parsed = JSON.parse(`[${calldata}]`);
const [a, b, c, pubSignals] = parsed;

const fixture = { a, b, c, pubSignals };
const outPath = path.resolve(__dirname, "../../contracts/test/fixtures/joinsplit2x2_proof.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
console.log(`Wrote ${outPath}`);
