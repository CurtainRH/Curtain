// Copies each circuit's snarkjs-generated Verifier.sol into contracts/,
// renaming the contract (snarkjs always names it `Groth16Verifier`, which
// collides once more than one is imported into the same project) to
// something unique per circuit/arity.
const path = require("path");
const fs = require("fs");

const targets = [
  { circuit: "joinsplit2x2", className: "JoinSplit2x2Groth16Verifier", outDir: "pool/generated" },
  { circuit: "joinsplit3x3", className: "JoinSplit3x3Groth16Verifier", outDir: "pool/generated" },
  { circuit: "ppoi_dev", className: "PpoiDevGroth16Verifier", outDir: "gate/generated" },
];

const baseDir = path.resolve(__dirname, "../../contracts/src");
for (const { circuit, className, outDir } of targets) {
  const srcPath = path.resolve(__dirname, `../build/${circuit}/Verifier.sol`);
  let src = fs.readFileSync(srcPath, "utf-8");
  src = src.replace(/contract Groth16Verifier/g, `contract ${className}`);
  // Pin the pragma to our project's exact compiler version instead of the
  // generator's permissive >=0.7.0 <0.9.0 range.
  src = src.replace(/pragma solidity >=0\.7\.0 <0\.9\.0;/, "pragma solidity 0.8.26;");

  const fullOutDir = path.join(baseDir, outDir);
  fs.mkdirSync(fullOutDir, { recursive: true });
  const outPath = path.join(fullOutDir, `${className}.sol`);
  fs.writeFileSync(outPath, src);
  console.log(`Wrote ${outPath}`);
}
