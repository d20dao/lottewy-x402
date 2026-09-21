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
export async function referencePrice(env: Env): Promise<string> {
  if (env.PRICING_MODE !== "cost") return env.PRICE_USDC;
  const profile = hash([
    "discovery-price-v2",
    env.CONSUMER_ADDRESS,
    env.CONSUMER_CODE_HASH,
    env.IMPLEMENTATION_ADDRESS,
    env.IMPLEMENTATION_CODE_HASH,
    env.SELLER_ADDRESS,
    env.RPC_URL,
    env.GAS_LIMIT,
    env.MAX_QUOTE_USDC || "1.000000",
  ]);
  // Default D1 queries use the primary. An isolate-local cache cannot keep
  // discovery and a subsequent challenge consistent across different isolates.
  const current = await env.DB.prepare(
    "SELECT amount FROM discovery_prices WHERE profile=? AND expires>unixepoch()",
  )
    .bind(profile)
    .first<{ amount: string }>();
  if (current) return current.amount;
  const id = crypto.randomUUID();
  const ticket = {
    id,
    owner: env.SELLER_ADDRESS,
    commitment: hash(["lottewy-price-reference", id]),
    price: "0.000000",
  } as Ticket;
  const amount = priceBreakdown(await executionPlan(env, ticket, true)).amount;
  // Concurrent refreshes all return the winning value, never their local
  // estimate. This is discovery only; real charges remain bound to draftToken.
  const saved = await env.DB.prepare(
    `
    INSERT INTO discovery_prices(profile,amount,expires) VALUES (?, ?, unixepoch()+300)
    ON CONFLICT(profile) DO UPDATE SET
      amount=CASE WHEN discovery_prices.expires<=unixepoch() THEN excluded.amount ELSE discovery_prices.amount END,
      expires=CASE WHEN discovery_prices.expires<=unixepoch() THEN excluded.expires ELSE discovery_prices.expires END
    RETURNING amount
  `,
  )
    .bind(profile, amount)
    .first<{ amount: string }>();
  if (!saved) throw new Error("Discovery price unavailable");
  return saved.amount;
}
