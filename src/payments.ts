import type { Request, Response } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { hash, type Giveaway } from "./protocol/shared/core";
import { review } from "./protocol/worker/jev";
import { storeJson } from "./protocol/worker/storage";
import {
  ApiError,
  GATEWAY_URL,
  NETWORKS,
  requireValue,
  type Env,
} from "./config";
import { openTicket, materialize } from "./tickets";
import { operation, quota, guard } from "./store";
import { executionPlan, processJobs, publicOperation, relayer } from "./chain";
import { assertSalesAvailable, noCaptureReasons } from "./settlement";
import { referencePrice } from "./pricing";

const gatewayFor = (env: Env) =>
  createGatewayMiddleware({
    sellerAddress: env.SELLER_ADDRESS,
    facilitatorUrl: GATEWAY_URL,
    networks: NETWORKS,
    description:
      "Create one verifiable giveaway draw on Arc. Includes D20DAO and execution costs. Follow the advertised payment network.",
  });
export function paidRoll(env: Env, schedule: (work: Promise<unknown>) => void) {
  const unpaidGateway = gatewayFor(env);
  return async (req: Request, res: Response) => {
    const header = req.headers["payment-signature"];
    if (!header && !req.body?.draftToken) {
      await unpaidGateway.require("$" + (await referencePrice(env)))(
        req,
        res,
        () => {},
      );
      return;
    }
    const ticket = await openTicket(env, req.body?.draftToken);
    const existing = await operation(env, ticket.id);
    if (existing) {
      requireValue(
        existing.owner === ticket.owner &&
          existing.commitment === ticket.commitment,
        "Operation binding mismatch",
      );
      res
        .status(
          ["settling", "payment_uncertain", "manual_review"].includes(
            existing.status,
          )
            ? 202
            : 200,
        )
        .json(publicOperation(env, existing));
      return;
    }
    await assertSalesAvailable(env);
    requireValue(
      ticket.expires > Math.floor(Date.now() / 1000),
      "Draft quote expired. Create a fresh draft before paying",
    );
    requireValue(
      env.PRICING_MODE === "cost"
        ? ticket.pricingMode === "cost" && !!ticket.executionQuote
        : ticket.price === env.PRICE_USDC,
      "Pricing changed. Create a fresh draft before paying",
    );
    if (!header) {
      await unpaidGateway.require("$" + ticket.price)(req, res, () => {});
      return;
    }
    requireValue(
      typeof header === "string" && header.length < 32768,
      "Invalid payment header",
    );
    requireValue(
      ticket.expires > Math.floor(Date.now() / 1000),
      "Draft expired. Create a fresh draft before paying",
    );
    requireValue(
      env.PRICING_MODE === "cost" || ticket.price === env.PRICE_USDC,
      "Price changed. Create a fresh draft before paying",
    );
    let payload: any;
    try {
      payload = JSON.parse(
        Buffer.from(header as string, "base64").toString("utf8"),
      );
    } catch {
      throw new ApiError(400, "INVALID_PAYMENT", "Payment header is malformed");
    }
    const authorization = payload?.payload?.authorization;
    requireValue(
      payload.x402Version === 2 &&
        authorization &&
        typeof authorization.from === "string" &&
        authorization.from.toLowerCase() === ticket.owner &&
        /^0x[\da-f]{64}$/i.test(authorization.nonce),
      "Payment payer must match the draft owner",
    );
    requireValue(
      NETWORKS.includes(payload.accepted?.network),
      "Only advertised payment networks are supported",
    );
    // The replay key uses the actual authorization identity, never client-supplied asset metadata.
    const paymentKey = hash([
      "gateway-payment-v1",
      payload.accepted.network,
      authorization.from.toLowerCase(),
      authorization.nonce.toLowerCase(),
    ]);
    const built = materialize(ticket),
      gateway = gatewayFor(env);
    let failure: ApiError | undefined,
      verifiedPayer = "",
      settlementStarted = false,
      settlementStored = false;
    const end = res.end.bind(res);
    res.end = ((chunk: any, ...args: any[]) => {
      if (failure && !res.headersSent) {
        res.statusCode = failure.status;
        res.removeHeader("content-length");
        res.setHeader("content-type", "application/json");
        return end(
          JSON.stringify({
            error: failure.message,
            code: failure.code,
            id: ticket.id,
            statusUrl: `${env.PUBLIC_ORIGIN}/v1/giveaways/${ticket.id}`,
          }),
        );
      }
      return (end as any)(chunk, ...args);
    }) as any;
    gateway.onAfterVerify(async (context) => {
      verifiedPayer = (
        context.result.payer || authorization.from
      ).toLowerCase();
    });
    gateway.onBeforeSettle(async () => {
      try {
        if (verifiedPayer !== ticket.owner)
          throw new ApiError(
            403,
            "PAYER_MISMATCH",
            "Verified payment payer does not match the draft owner",
          );
        await assertSalesAvailable(env);
        const bound = await env.DB.prepare(
          "SELECT id FROM operations WHERE payment_key=?",
        )
          .bind(paymentKey)
          .first();
        if (bound)
          throw new ApiError(
            409,
            "PAYMENT_ALREADY_BOUND",
            "This authorization belongs to an existing operation. Reuse that original draftToken.",
          );
        await quota(env, `review-minute:${ticket.owner}`, 60, 3);
        await quota(env, `review-hour:${ticket.owner}`, 3600, 20);
        await quota(env, "review-global", 3600, 200);
        const plan = await executionPlan(env, ticket);
        let checked;
        try {
          checked = await review(ticket.draft, {
            MODE: "production",
            JEV_MODE: "live",
            JEV_MODEL: env.JEV_MODEL,
            JEV_API_KEY: env.JEV_API_KEY,
          });
        } catch (error) {
          throw new ApiError(
            422,
            "CONTENT_REVIEW_REJECTED",
            (error as Error).message,
          );
        }
        if (
          !/^\d{1,20}$/.test(String(authorization.validBefore)) ||
          BigInt(authorization.validBefore) <
            BigInt(Math.floor(Date.now() / 1000) + 604840)
        )
          throw new ApiError(
            400,
            "PAYMENT_EXPIRY_TOO_CLOSE",
            "Refresh the Gateway authorization validity window before paying. No payment was captured.",
          );
        const g = {
          id: ticket.id,
          slug: ticket.id,
          owner: ticket.owner,
          revision: 1,
          status: "paid",
          created: Math.floor(Date.now() / 1000),
          listed: false,
          manifest: built.manifest,
          commitment: built.commitment,
          review: {
            mode: checked.mode,
            model: checked.model,
            policy: checked.policy,
          },
          execution: plan,
          refundAddress: relayer(env).address,
        } as Giveaway;
        const text = JSON.stringify(g);
        if (Buffer.byteLength(text) > 1800000)
          throw new ApiError(
            413,
            "MANIFEST_TOO_LARGE",
            "The public manifest exceeds the storage budget",
          );
        const storedPayment = storeJson(
          env.DB,
          `payment:${ticket.id}`,
          payload,
        );
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO operations(id,owner,commitment,payment_key,status,public_json,created,amount,payment_network,payment_ref,review_json,reserved_units) SELECT ?,?,?,?,'settling',?,?,?,?,?,?,? WHERE COALESCE((SELECT SUM(reserved_units) FROM operations WHERE release_block IS NULL OR release_block>?),0)+COALESCE((SELECT SUM(reserved_units) FROM recovery_transactions WHERE release_block IS NULL OR release_block>?),0)+?<=?",
          ).bind(
            ticket.id,
            ticket.owner,
            ticket.commitment,
            paymentKey,
            text,
            g.created,
            ticket.price,
            payload.accepted.network,
            storedPayment.reference,
            JSON.stringify(checked),
            plan.reservedUnits,
            plan.blockNumber,
            plan.blockNumber,
            plan.reservedUnits,
            plan.balanceUnits,
          ),
          guard(env),
          ...storedPayment.statements,
          env.DB.prepare("DELETE FROM atomic_guard"),
        ]);
        settlementStarted = true;
      } catch (error) {
        failure =
          error instanceof ApiError
            ? error
            : new ApiError(
                409,
                "OPERATION_NOT_RESERVED",
                "The operation already exists or execution capacity changed. Check its status before retrying payment.",
              );
        return { abort: true, reason: failure.code, message: failure.message };
      }
    });
    gateway.onAfterSettle(async (context) => {
      try {
        if (!context.result.success) {
          if (noCaptureReasons.has(context.result.errorReason || "")) {
            await env.DB.prepare(
              "UPDATE operations SET status='payment_failed',release_block=0,error_code='PAYMENT_REJECTED' WHERE id=? AND payment_key=? AND status='settling'",
            )
              .bind(ticket.id, paymentKey)
              .run();
            failure = new ApiError(
              402,
              "PAYMENT_REJECTED",
              "Gateway declined this payment without capture. Check the wallet balance and payment requirements.",
            );
            return;
          }
          await env.DB.prepare(
            "UPDATE operations SET status='payment_uncertain',error_code='PAYMENT_UNCERTAIN' WHERE id=? AND payment_key=? AND status='settling'",
          )
            .bind(ticket.id, paymentKey)
            .run();
          failure = new ApiError(
            503,
            "PAYMENT_UNCERTAIN",
            "Settlement needs verification. Poll the original operation; do not authorize another payment.",
          );
          return;
        }
        const result = await env.DB.prepare(
          "UPDATE operations SET status='paid',settlement_json=? WHERE id=? AND payment_key=? AND status='settling'",
        )
          .bind(JSON.stringify(context.result), ticket.id, paymentKey)
          .run();
        if (result.meta.changes !== 1) throw new Error();
        settlementStored = true;
      } catch {
        failure = new ApiError(
          503,
          "PAYMENT_UNCERTAIN",
          "Payment may have settled. Keep this operation ID and poll its status; do not authorize a new payment.",
        );
      }
    });
    gateway.onSettleFailure(async () => {
      failure = new ApiError(
        503,
        "PAYMENT_UNCERTAIN",
        "Payment status is uncertain. Keep this operation ID and poll its status; do not authorize a new payment.",
      );
      if (settlementStarted)
        try {
          await env.DB.prepare(
            "UPDATE operations SET status='payment_uncertain',error_code='PAYMENT_UNCERTAIN' WHERE id=? AND status='settling'",
          )
            .bind(ticket.id)
            .run();
        } catch {}
    });
    await gateway.require("$" + ticket.price)(req, res, () => {
      void (async () => {
        if (!settlementStored) {
          res.status(503).json({
            id: ticket.id,
            code: "PAYMENT_UNCERTAIN",
            error:
              "Payment requires reconciliation. Do not authorize another payment.",
          });
          return;
        }
        const saved = await operation(env, ticket.id);
        if (!saved) {
          res
            .status(503)
            .json({ id: ticket.id, code: "OPERATION_UNAVAILABLE" });
          return;
        }
        schedule(processJobs(env));
        res.status(200).json(publicOperation(env, saved));
      })().catch(() => {
        if (!res.headersSent)
          res.status(503).json({
            id: ticket.id,
            code: "OPERATION_UNAVAILABLE",
            error:
              "Poll the original operation; do not authorize another payment.",
          });
      });
    });
  };
}
