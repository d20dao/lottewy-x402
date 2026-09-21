import { parseUnits } from "viem";
import { ApiError, GATEWAY_URL, type Env } from "./config";
import { loadJson } from "./protocol/worker/storage";
import { lease, release, type Operation } from "./store";

// Circle's documented payer refusals prove no capture. Nonce reuse and unknown
// errors do not: a previous settlement may have succeeded without its response.
export const noCaptureReasons = new Set([
  "unsupported_scheme",
  "unsupported_network",
  "unsupported_asset",
  "unsupported_domain",
  "invalid_payload",
  "address_mismatch",
  "amount_mismatch",
  "invalid_signature",
  "authorization_not_yet_valid",
  "authorization_expired",
  "authorization_validity_too_short",
  "self_transfer",
  "insufficient_balance",
  "wallet_not_found",
]);

const acceptedStates = new Set([
  "received",
  "batched",
  "confirmed",
  "completed",
]);
const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** An absent or malformed lookup never authorizes a second settlement. */
export async function reconcilePayments(env: Env) {
  const token = await lease(env, "payments");
  if (!token) return;
  try {
    const now = Date.now();
    const rows = await env.DB.prepare(
      `SELECT * FROM operations
    WHERE status IN ('settling','payment_uncertain','manual_review') AND created<?
      AND checked_at < ? - CASE WHEN status='manual_review' THEN 570000 ELSE 0 END
    ORDER BY checked_at LIMIT 3`,
    )
      .bind(Math.floor(now / 1000) - 30, now - 30000)
      .all<Operation>();
    for (const op of rows.results) {
      try {
        const payload = (await loadJson(env.DB, op.payment_ref)) as any;
        const auth = payload?.payload?.authorization;
        if (
          !auth ||
          !same(auth.from, op.owner) ||
          typeof auth.nonce !== "string"
        )
          continue;
        const url = new URL("/v1/x402/transfers", GATEWAY_URL);
        url.searchParams.set("from", op.owner);
        url.searchParams.set("nonce", auth.nonce);
        url.searchParams.set("network", op.payment_network);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) continue;
        const body = (await response.json()) as any;
        if (!Array.isArray(body?.transfers)) continue;
        // Compare every financial binding with our immutable journal, not the client's accepted metadata.
        const matching = body.transfers.filter(
          (t: any) =>
            t &&
            typeof t.id === "string" &&
            same(t.fromAddress, op.owner) &&
            same(t.toAddress, env.SELLER_ADDRESS) &&
            same(t.nonce, auth.nonce) &&
            t.sendingNetwork === op.payment_network &&
            t.token === "USDC" &&
            typeof t.amount === "string" &&
            /^\d+$/.test(t.amount) &&
            BigInt(t.amount) === parseUnits(op.amount, 6),
        );
        if (matching.length !== 1) continue;
        const transfer = matching[0];
        if (acceptedStates.has(transfer.status)) {
          await env.DB.prepare(
            `UPDATE operations SET status='paid',settlement_json=?,error_code=NULL
          WHERE id=? AND status IN ('settling','payment_uncertain','manual_review') AND EXISTS(SELECT 1 FROM leases WHERE name='payments' AND token=? AND expires>?)`,
          )
            .bind(
              JSON.stringify({ source: "gateway-transfer-lookup", transfer }),
              op.id,
              token,
              Date.now(),
            )
            .run();
        } else if (transfer.status === "failed") {
          await env.DB.prepare(
            `UPDATE operations SET status='payment_failed',release_block=0,error_code='PAYMENT_REJECTED'
          WHERE id=? AND status IN ('settling','payment_uncertain','manual_review') AND EXISTS(SELECT 1 FROM leases WHERE name='payments' AND token=? AND expires>?)`,
          )
            .bind(op.id, token, Date.now())
            .run();
        }
      } catch {
        // Preserve payment identity and reserved execution funds until Gateway provides evidence.
      } finally {
        await env.DB.prepare(
          `UPDATE operations SET checked_at=MAX(checked_at,?),
        status=CASE WHEN status IN ('settling','payment_uncertain') AND created<? THEN 'manual_review' ELSE status END,
        error_code=CASE WHEN status IN ('settling','payment_uncertain') AND created<? THEN 'PAYMENT_REVIEW_REQUIRED' ELSE error_code END
        WHERE id=? AND EXISTS(SELECT 1 FROM leases WHERE name='payments' AND token=? AND expires>?)`,
        )
          .bind(
            Date.now(),
            Math.floor(Date.now() / 1000) - 3600,
            Math.floor(Date.now() / 1000) - 3600,
            op.id,
            token,
            Date.now(),
          )
          .run();
      }
    }
  } finally {
    await release(env, "payments", token);
  }
}

/** Refuse additional sales while existing customers need payment/delivery recovery. */
export async function assertSalesAvailable(env: Env) {
  if (
    env.MODE === "production" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SUPPORT_EMAIL || "")
  )
    throw new ApiError(
      503,
      "CONFIGURATION_PENDING",
      "Service contact configuration is pending. No payment was captured.",
    );
  const blocked = await env.DB.prepare(
    `SELECT 1 AS blocked WHERE EXISTS(SELECT 1 FROM operations WHERE status='submitting' AND created<?)
    OR EXISTS(SELECT 1 FROM recovery_transactions WHERE status='pending' AND created<?)`,
  )
    .bind(Math.floor(Date.now() / 1000) - 300, Date.now() - 300000)
    .first();
  if (blocked)
    throw new ApiError(
      503,
      "SALES_PAUSED",
      "A pending onchain transaction needs recovery. New payments are paused.",
    );
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM operations WHERE
    (status IN ('settling','payment_uncertain') AND created<?) OR
    (status IN ('refund_due','expired') AND created>?) OR
    (status IN ('paid','submitting') AND created<?)`,
  )
    .bind(
      Math.floor(Date.now() / 1000) - 600,
      Math.floor(Date.now() / 1000) - 3600,
      Math.floor(Date.now() / 1000) - 600,
    )
    .first<{ n: number }>();
  if (!row || row.n >= 3)
    throw new ApiError(
      503,
      "SALES_PAUSED",
      "New payments are paused while earlier operations are reconciled. No payment was captured.",
    );
}
