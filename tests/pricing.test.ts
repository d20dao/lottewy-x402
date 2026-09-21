import { it, expect, vi } from "vitest";
import { database } from "./d1";
import type { Env } from "../src/config";
vi.mock("../src/chain", () => ({ executionPlan: vi.fn() }));
import { executionPlan } from "../src/chain";
import { referencePrice } from "../src/pricing";

it("shares the winning estimate across concurrent refreshes and independent callers", async () => {
  const db = database();
  const env = {
    DB: db,
    PRICING_MODE: "cost",
    CONSUMER_ADDRESS: "consumer",
    CONSUMER_CODE_HASH: "code",
    IMPLEMENTATION_ADDRESS: "implementation",
    IMPLEMENTATION_CODE_HASH: "implcode",
    SELLER_ADDRESS: "seller",
    RPC_URL: "rpc",
    GAS_LIMIT: "1000000",
    MAX_QUOTE_USDC: "1.000000",
  } as unknown as Env;
  let calls = 0;
  vi.mocked(executionPlan).mockImplementation(async () => ({
    value: "50000000000000000",
    reservedUnits: 57278 + calls++,
    gas: "350000",
    maxFeePerGas: "1",
    balanceUnits: 1000000,
    blockNumber: 1,
  }));
  const prices = await Promise.all(
    Array.from({ length: 8 }, () => referencePrice({ ...env })),
  );
  expect(new Set(prices).size).toBe(1);
  expect(calls).toBe(8);
  expect(await referencePrice({ ...env })).toBe(prices[0]);
  expect(calls).toBe(8);
  // A rolling expiry is evaluated by the shared database clock.
  db.sqlite.exec("UPDATE discovery_prices SET expires=0");
  const refreshed = await Promise.all([
    referencePrice(env),
    referencePrice({ ...env }),
  ]);
  expect(refreshed[0]).toBe(refreshed[1]);
  expect(refreshed[0]).not.toBe(prices[0]);
  // Deployment configuration changes never reuse a different profile's quote.
  expect(await referencePrice({ ...env, GAS_LIMIT: "999999" })).not.toBe(
    refreshed[0],
  );
});
