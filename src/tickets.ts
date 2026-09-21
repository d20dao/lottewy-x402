import {
  hash,
  makeManifest,
  normalize,
  type Draft,
} from "./protocol/shared/core";
import { assertPublicContent } from "./protocol/worker/content-filter";
import type { Address, Hex } from "viem";
import { ApiError, requireValue, type Env } from "./config";
import { executionPlan } from "./chain";
import { priceBreakdown } from "./pricing";
export type Ticket = {
  version: 1;
  id: string;
  owner: Address;
  draft: Draft;
  salts: Hex[];
  commitment: Hex;
  expires: number;
  price: string;
  consumer: string;
  pricingMode?: "cost";
  executionQuote?: { value: string; gas: string; maxFeePerGas: string };
};
const bytes = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
function base64(value: Uint8Array) {
  let result = "";
  for (let i = 0; i < value.length; i += 16384)
    result += String.fromCharCode(...value.subarray(i, i + 16384));
  return btoa(result);
}
async function key(secret: string) {
  requireValue(
    /^[a-f\d]{64}$/i.test(secret),
    "Draft signing configuration is unavailable",
  );
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/../g)!, (p) => parseInt(p, 16)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
const context = (env: Env) =>
  new TextEncoder().encode(
    `lottewy-agent-ticket-v1:${env.PUBLIC_ORIGIN}:${env.CONSUMER_ADDRESS}`,
  );
export async function seal(env: Env, ticket: Ticket) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context(env) },
      await key(env.DRAFT_SECRET),
      new TextEncoder().encode(JSON.stringify(ticket)),
    );
  return `${base64(iv)}.${base64(new Uint8Array(cipher))}`;
}
export async function openTicket(env: Env, token: unknown): Promise<Ticket> {
  requireValue(
    typeof token === "string" && token.length < 12000000,
    "A valid draftToken is required",
  );
  try {
    const parts = (token as string).split(".");
    if (parts.length !== 2) throw new Error();
    const text = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(parts[0]), additionalData: context(env) },
      await key(env.DRAFT_SECRET),
      bytes(parts[1]),
    );
    const ticket = JSON.parse(new TextDecoder().decode(text));
    if (
      ticket.version !== 1 ||
      ticket.consumer.toLowerCase() !== env.CONSUMER_ADDRESS.toLowerCase()
    )
      throw new Error();
    return ticket;
  } catch {
    throw new ApiError(
      400,
      "INVALID_DRAFT_TOKEN",
      "Draft token is invalid for this API deployment. Create a fresh draft.",
    );
  }
}
export async function prepare(env: Env, input: any) {
  requireValue(
    input && /^0x[\da-f]{40}$/i.test(input.owner),
    "owner must be the EVM wallet address that will pay through Gateway",
  );
  const draft = normalize({ description: "", reserves: 0, ...input.draft });
  assertPublicContent(draft);
  const id = crypto.randomUUID(),
    owner = input.owner.toLowerCase() as Address,
    built = makeManifest(draft, id, owner, 1);
  const ticket: Ticket = {
    version: 1,
    id,
    owner,
    draft,
    salts: built.privateEntries.map((e) => e.salt),
    commitment: built.commitment,
    expires: Math.floor(Date.now() / 1000) + 1800,
    price: env.PRICE_USDC,
    consumer: env.CONSUMER_ADDRESS,
  };
  let breakdown: ReturnType<typeof priceBreakdown> | undefined;
  if (env.PRICING_MODE === "cost") {
    const plan = await executionPlan(env, ticket, true);
    breakdown = priceBreakdown(plan);
    ticket.price = breakdown.amount;
    ticket.expires = Math.floor(Date.now() / 1000) + 300;
    ticket.pricingMode = "cost";
    ticket.executionQuote = {
      value: plan.value,
      gas: plan.gas,
      maxFeePerGas: plan.maxFeePerGas,
    };
  }
  return {
    id,
    status: "prepared",
    draftToken: await seal(env, ticket),
    commitment: built.commitment,
    manifest: built.manifest,
    privateArchive: { draft, entries: built.privateEntries },
    expiresAt: ticket.expires,
    price: breakdown || { amount: ticket.price, currency: "USDC" },
    quoteOpenapi: {
      method: "POST",
      url: `${env.PUBLIC_ORIGIN}/v1/quote/openapi`,
    },
    next: { method: "POST", url: `${env.PUBLIC_ORIGIN}/v1/roll` },
  };
}
export function materialize(ticket: Ticket) {
  const built = makeManifest(
    ticket.draft,
    ticket.id,
    ticket.owner,
    1,
    ticket.salts,
  );
  requireValue(
    built.commitment === ticket.commitment &&
      hash(built.manifest) === ticket.commitment,
    "Draft commitment mismatch",
  );
  return built;
}
