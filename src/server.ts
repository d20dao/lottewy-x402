import { apiDocs } from "./docs";
import { brandSvg } from "./branding";
import express from "express";
import { ApiError, type Env } from "./config";
import { openapi } from "./openapi";
import { prepare } from "./tickets";
import { operation, quota } from "./store";
import { publicOperation, processJobs } from "./chain";
import { paidRoll } from "./payments";
import { hash, CHAIN_ID } from "./protocol/shared/core";
import { isMainnet } from "./protocol/shared/network";
import { verifyD20 } from "./protocol/shared/proof";
import {
  proofBundle,
  serializeProofBundle,
} from "./protocol/shared/proof-bundle";
import { loadJson, storeJson } from "./protocol/worker/storage";
import { clientKey } from "./client-key";
import { assertSalesAvailable } from "./settlement";
import { referencePrice } from "./pricing";
export function createApp(
  env: Env,
  schedule: (work: Promise<unknown>) => void,
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("env", "production");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "PAYMENT-REQUIRED,PAYMENT-RESPONSE",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,PAYMENT-SIGNATURE",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    next();
  });
  app.use((req, res, next) => {
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: "16mb" }));
  app.get("/", (_req, res) =>
    res.json({
      name: "Lottewy Agent Giveaway API",
      logo: env.WEB_ORIGIN + "/brand/apple-touch-icon.png",
      network: isMainnet ? "Arc Mainnet" : "Arc Testnet",
      openapi: `${env.PUBLIC_ORIGIN}/openapi.json`,
      docs: `${env.PUBLIC_ORIGIN}/docs`,
    }),
  );
  app.get("/health", async (_req, res) => {
    const configured =
      !!env.JEV_API_KEY &&
      /^[a-f\d]{64}$/i.test(env.DRAFT_SECRET || "") &&
      !!env.RELAYER_PRIVATE_KEY &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SUPPORT_EMAIL || "");
    let available = false;
    try {
      await assertSalesAvailable(env);
      available = true;
    } catch {}
    res.status(configured && available ? 200 : 503).json({
      status: !configured
        ? "configuration_pending"
        : available
          ? "ok"
          : "sales_paused",
      chainId: CHAIN_ID,
      mainnet: isMainnet,
      payments: isMainnet ? "Circle Gateway USDC" : "Circle Gateway testnet",
      consumer: env.CONSUMER_ADDRESS,
      checks:
        "Configuration and queued work; live chain checks run before payment capture.",
    });
  });
  app.get("/openapi.json", async (_req, res) =>
    res.json(openapi({ ...env, PRICE_USDC: await referencePrice(env) })),
  );
  app.get("/docs", (_req, res) => res.type("html").send(apiDocs(env)));
  app.get(["/logo.svg", "/favicon.svg", "/favicon.ico"], (_req, res) =>
    res
      .type("image/svg+xml")
      .set("Cache-Control", "public, max-age=86400")
      .send(brandSvg),
  );
  app.use("/v1", async (req, _res, next) => {
    try {
      const ip = clientKey(
        String(req.headers["cf-connecting-ip"] || req.ip || ""),
      );
      await quota(env, `ip:${hash(String(ip))}`, 60, 60);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.post("/v1/giveaways", async (req, res, next) => {
    try {
      await quota(
        env,
        `prepare:${hash(clientKey(String(req.headers["cf-connecting-ip"] || req.ip || "")))}`,
        60,
        10,
      );
      res.json(await prepare(env, req.body));
    } catch (error) {
      next(error);
    }
  });
  const roll = paidRoll(env, schedule);
  app.post("/v1/roll", (req, res, next) => {
    void roll(req, res).catch(next);
  });
  app.get("/v1/giveaways/:id", async (req, res, next) => {
    try {
      const op = await operation(env, String(req.params.id));
      if (!op)
        throw new ApiError(
          404,
          "NOT_FOUND",
          "No paid operation exists for this giveaway ID",
        );
      res.json(publicOperation(env, op));
      if (["paid", "submitting", "waiting", "callback"].includes(op.status))
        schedule(processJobs(env));
    } catch (error) {
      next(error);
    }
  });
  app.get("/v1/giveaways/:id/proof", async (req, res, next) => {
    try {
      const op = await operation(env, String(req.params.id));
      if (!op) throw new ApiError(404, "NOT_FOUND", "Giveaway not found");
      if (op.status !== "completed")
        throw new ApiError(409, "NOT_COMPLETED", "The draw is not complete");
      let proof;
      if (op.proof_ref) proof = await loadJson(env.DB, op.proof_ref);
      else {
        const g = JSON.parse(op.public_json),
          verified = await verifyD20(g, env.RPC_URL);
        proof = JSON.parse(
          serializeProofBundle(proofBundle(g, g.evidence.word, verified)),
        );
        const stored = storeJson(env.DB, `proof:${op.id}`, proof);
        try {
          await env.DB.batch([
            ...stored.statements,
            env.DB.prepare(
              "UPDATE operations SET proof_ref=? WHERE id=? AND proof_ref IS NULL",
            ).bind(stored.reference, op.id),
          ]);
        } catch {
          /* Another verified export may already have cached the same public proof. */
        }
      }
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="lottewy-${op.id}-proof.json"`,
      );
      res.json(proof);
    } catch (error) {
      next(error);
    }
  });
  app.use((_req, res) =>
    res.status(404).json({ code: "NOT_FOUND", error: "Endpoint not found" }),
  );
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) return;
      const safe = error instanceof ApiError;
      res
        .status(
          safe ? error.status : error.type === "entity.too.large" ? 413 : 400,
        )
        .json({
          code: safe ? error.code : "REQUEST_FAILED",
          error: safe
            ? error.message
            : "The request could not be completed. Check the schema or retry later.",
        });
    },
  );
  return app;
}
