// Local helper functions. Importing this module does not create a draw or make a payment.
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { parseUnits } from "viem";
const API = "https://api.lottewy.com";

export async function prepareGiveaway(owner, draft) {
  const response = await fetch(API + "/v1/giveaways", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, draft }),
  });
  if (!response.ok) throw new Error("Preparation failed: " + response.status);
  // Persist the entire result privately BEFORE paying, including draftToken and privateArchive.
  return response.json();
}

export async function rollPrepared(privateKey, prepared) {
  // Call only after authorizing this real-USDC quote. The key is used locally, never in the HTTP body.
  // A fresh client keeps each operation's price guard independent.
  const gateway = new GatewayClient({ chain: "arc", privateKey });
  if (gateway.address.toLowerCase() !== prepared.manifest.owner.toLowerCase())
    throw new Error("Use the wallet that owns the draft");
  const cap = parseUnits(prepared.price.amount, 6);
  gateway.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    if (
      selectedRequirements.network !== "eip155:5042" ||
      BigInt(selectedRequirements.amount) > cap
    )
      return { abort: true, reason: "Network or quote changed; do not sign" };
  });
  // Reuse the same saved prepared object after uncertain/lost responses. Never prepare another draw to retry.
  const result = await gateway.pay(API + "/v1/roll", {
    method: "POST",
    body: { draftToken: prepared.draftToken },
  });
  return result.data;
}

export async function readGiveaway(id) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
    throw new Error("Invalid giveaway ID");
  const response = await fetch(API + "/v1/giveaways/" + id);
  if (!response.ok) throw new Error("Status unavailable: " + response.status);
  return response.json();
}
