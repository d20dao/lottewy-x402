import { hash } from "./protocol/shared/core";
import { executionPlan } from "./chain";
import type { Env } from "./config";
import type { Ticket } from "./tickets";
const MICRO = 1000000000000n;
const decimal = (units: bigint) =>
  `${units / 1000000n}.${(units % 1000000n).toString().padStart(6, "0")}`;
export function priceBreakdown(plan: { value: string; reservedUnits: number }) {
  const total = BigInt(plan.reservedUnits),
    service = (BigInt(plan.value) + MICRO - 1n) / MICRO;
  if (service > total) throw new Error("Invalid cost quote");
  return {
    amount: decimal(total),
    currency: "USDC",
    mode: "cost_estimate",
    serviceFee: decimal(service),
    gasBudget: decimal(total - service),
    platformFee: "0.000000",
    description:
      "D20DAO fee budget plus estimated gas budget, rounded up to six decimals. No platform markup. Actual network spending may be lower.",
  };
}
let cached: { key: string; until: number; work: Promise<string> } | undefined;
export function referencePrice(env: Env): Promise<string> {
  if (env.PRICING_MODE !== "cost") return Promise.resolve(env.PRICE_USDC);
  const key = [
    env.CONSUMER_ADDRESS,
    env.RPC_URL,
    env.GAS_LIMIT,
    env.MAX_QUOTE_USDC,
  ].join(":");
  if (cached?.key === key && cached.until > Date.now()) return cached.work;
  const id = crypto.randomUUID();
  const ticket = {
    id,
    owner: env.SELLER_ADDRESS,
    commitment: hash(["lottewy-price-reference", id]),
    price: "0.000000",
  } as Ticket;
  const work = executionPlan(env, ticket, true).then(
    (plan) => priceBreakdown(plan).amount,
  );
  cached = { key, until: Date.now() + 30000, work };
  work.catch(() => {
    if (cached?.work === work) cached = undefined;
  });
  return work;
}
