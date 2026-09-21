import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { executionPlan } from "../src/chain";
import { hash } from "../src/protocol/shared/core";
import deployment from "../src/protocol/docs/lottewy-testnet.json";
it.skipIf(process.env.LIVE_CHAIN_CHECK !== "1")(
  "verifies the deployed proxy and relayer budget with read-only Arc calls",
  async () => {
    const secrets = parseEnv(readFileSync(".env", "utf8"));
    const env = {
      ...secrets,
      CONSUMER_ADDRESS: deployment.address,
      CONSUMER_CODE_HASH: deployment.codeHash,
      IMPLEMENTATION_ADDRESS: deployment.implementationAddress,
      IMPLEMENTATION_CODE_HASH: deployment.implementationCodeHash,
      RPC_URL: "https://rpc.drpc.testnet.arc.io",
      PRICE_USDC: "0.250000",
      GAS_LIMIT: "1000000",
    } as any;
    const plan = await executionPlan(env, {
      id: crypto.randomUUID(),
      owner: deployment.owner.toLowerCase(),
      commitment: hash("read-only-budget-check"),
    } as any);
    expect(plan.reservedUnits).toBeLessThanOrEqual(250000);
    expect(plan.balanceUnits).toBeGreaterThanOrEqual(plan.reservedUnits);
    console.log({
      value: plan.value,
      reservedMicroUsdc: plan.reservedUnits,
      relayerBalanceMicroUsdc: plan.balanceUnits,
    });
  },
);
