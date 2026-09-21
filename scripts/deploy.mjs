import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const config = JSON.parse(
  readFileSync("wrangler.jsonc", "utf8").replace(/,\s*([}\]])/g, "$1"),
);
const target = config.env?.testnet;
if (
  !target ||
  target.vars?.MODE !== "production" ||
  target.vars?.PUBLIC_ORIGIN !== "https://api.lottewy.com"
)
  throw new Error(
    "A reviewed testnet deployment environment is required. Do not deploy local defaults.",
  );
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.vars.SUPPORT_EMAIL || ""))
  throw new Error(
    "Configure an approved public support email before deployment.",
  );
if (!/^\d+\.\d{6}$/.test(target.vars.PRICE_USDC || ""))
  throw new Error(
    "Configure the approved fixed test USDC price before deployment.",
  );
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  { stdio: "inherit" },
);
execFileSync(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "deploy", "--env", "testnet"],
  { stdio: "inherit" },
);
