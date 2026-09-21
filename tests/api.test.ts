import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { generatePrivateKey } from "viem/accounts";
import { once } from "node:events";
import SwaggerParser from "@apidevtools/swagger-parser";
import { database } from "./d1";
import type { Env } from "../src/config";
import { hash } from "../src/protocol/shared/core";
vi.mock("../src/chain", async (original) => ({
  ...(await original<typeof import("../src/chain")>()),
  executionPlan: async () => ({
    value: "80000000000000000",
    gas: "350000",
    maxFeePerGas: "1000000000",
    reservedUnits: 90000,
    balanceUnits: 1000000,
    blockNumber: 100,
  }),
  processJobs: async () => {},
}));
import { createApp } from "../src/server";
import { reconcilePayments, assertSalesAvailable } from "../src/settlement";
const nativeFetch = globalThis.fetch,
  owner = "0x0000000000000000000000000000000000000001",
  seller = "0x0000000000000000000000000000000000000002";
let db: ReturnType<typeof database>,
  env: Env,
  server: any,
  origin: string,
  settlements: number,
  reviews: number,
  rejectReview: boolean,
  settlementTimeout: boolean,
  settlementRefusal: string | undefined,
  lookup: any;
beforeEach(async () => {
  db = database();
  settlements = 0;
  reviews = 0;
  rejectReview = false;
  settlementTimeout = false;
  settlementRefusal = undefined;
  lookup = { transfers: [] };
  env = {
    DB: db as any,
    PUBLIC_ORIGIN: "https://api.example.test",
    WEB_ORIGIN: "https://web.example.test",
    SUPPORT_EMAIL: "support@example.test",
    SELLER_ADDRESS: seller,
    RELAYER_PRIVATE_KEY: generatePrivateKey(),
    DRAFT_SECRET: randomBytes(32).toString("hex"),
    RPC_URL: "http://unused",
    CONSUMER_ADDRESS: seller,
    CONSUMER_CODE_HASH: hash("code"),
    IMPLEMENTATION_ADDRESS: seller,
    IMPLEMENTATION_CODE_HASH: hash("impl"),
    PRICE_USDC: "0.100000",
    GAS_LIMIT: "350000",
    JEV_API_KEY: "test-only",
    JEV_MODEL: "jev-test",
    MODE: "production",
    JEV_MODE: "live",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, options: any) => {
      if (String(url).includes("/v1/x402/transfers?"))
        return new Response(JSON.stringify(lookup));
      if (String(url).endsWith("/supported"))
        return new Response(
          JSON.stringify({
            kinds: ["eip155:5042002", "eip155:84532"].map((network) => ({
              scheme: "exact",
              x402Version: 2,
              network,
              extra: {
                verifyingContract: seller,
                assets: [{ symbol: "USDC", address: seller, decimals: 6 }],
              },
            })),
            extensions: [],
            signers: {},
          }),
        );
      if (String(url).endsWith("/verify"))
        return new Response(JSON.stringify({ isValid: true, payer: owner }));
      if (String(url).endsWith("/settle")) {
        settlements++;
        if (settlementTimeout) throw new Error("Upstream timeout");
        if (settlementRefusal)
          return new Response(
            JSON.stringify({
              success: false,
              errorReason: settlementRefusal,
              transaction: "",
              network: "eip155:5042002",
            }),
          );
        return new Response(
          JSON.stringify({
            success: true,
            payer: owner,
            transaction: hash("settled"),
            network: "eip155:5042002",
          }),
        );
      }
      if (String(url).includes("typesafe.ai")) {
        reviews++;
        const body = JSON.parse(options.body);
        expect(body.state.entries).toBeUndefined();
        return new Response(
          JSON.stringify({
            answers: Object.fromEntries(
              [
                "secrets",
                "payment",
                "guarantee",
                "conflict",
                "profanity",
                "hate",
                "adult",
              ].map((key) => [
                key,
                { noul: rejectReview && key === "hate" ? 0.9 : 0.01 },
              ]),
            ),
          }),
        );
      }
      throw new Error("Unexpected network request");
    }),
  );
  server = createApp(env, (promise) => void promise).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
  db.sqlite.close();
});
const draft = {
  title: "Community drawing",
  rules: "Free entries with equal chances.",
  entries: ["Alice Private", "private@example.invalid"],
  winners: 1,
};
const post = (path: string, body: any, header?: string) =>
  nativeFetch(origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(header ? { "PAYMENT-SIGNATURE": header } : {}),
    },
    body: JSON.stringify(body),
  });
async function prepared() {
  return (await (await post("/v1/giveaways", { owner, draft })).json()) as any;
}
function payment(nonce = hash("nonce"), asset = seller) {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { network: "eip155:5042002", asset },
      payload: {
        signature: "0x11",
        authorization: {
          from: owner,
          to: seller,
          value: "100000",
          validAfter: "0",
          validBefore: "1999999999",
          nonce,
        },
      },
    }),
  ).toString("base64");
}
it("publishes valid OpenAPI 3.1 and a real multi-network unpaid 402 challenge", async () => {
  const spec = (await (
    await nativeFetch(origin + "/openapi.json")
  ).json()) as any;
  await SwaggerParser.validate(spec);
  expect(spec.openapi).toBe("3.1.0");
  expect(spec.paths["/v1/roll"].post["x-payment-info"].price).toEqual({
    mode: "fixed",
    currency: "USDC",
    amount: "0.100000",
  });
  const r = await post("/v1/roll", {});
  expect(r.status).toBe(402);
  const challenge = JSON.parse(
    Buffer.from(r.headers.get("payment-required")!, "base64").toString(),
  );
  expect(challenge.accepts).toHaveLength(2);
  expect(challenge.accepts.every((x: any) => x.amount === "100000")).toBe(true);
  expect(settlements).toBe(0);
});
it("binds the D20DAO plus gas estimate to the draft and charges that quote without markup", async () => {
  env.PRICING_MODE = "cost";
  env.MAX_QUOTE_USDC = "1.000000";
  const p = await prepared();
  expect(p.price).toMatchObject({
    amount: "0.090000",
    serviceFee: "0.080000",
    gasBudget: "0.010000",
    platformFee: "0.000000",
  });
  expect(p.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  const quoteSpecResponse = await post("/v1/quote/openapi", {
    draftToken: p.draftToken,
  });
  expect(quoteSpecResponse.status).toBe(200);
  const quoteSpec = (await quoteSpecResponse.json()) as any;
  await SwaggerParser.validate(quoteSpec);
  expect(quoteSpec.paths["/v1/roll"].post["x-payment-info"].price).toEqual({
    mode: "fixed",
    currency: "USDC",
    amount: p.price.amount,
  });
  expect(quoteSpec["x-quote-expires-at"]).toBe(p.expiresAt);
  expect(JSON.stringify(quoteSpec)).not.toContain(p.draftToken);
  expect(JSON.stringify(quoteSpec)).not.toContain(draft.entries[0]);
  expect(
    (await post("/v1/quote/openapi", { draftToken: "invalid" })).status,
  ).toBe(400);
  const response = await post("/v1/roll", { draftToken: p.draftToken });
  expect(response.status).toBe(402);
  const requirement = JSON.parse(
    Buffer.from(response.headers.get("payment-required")!, "base64").toString(),
  );
  expect(requirement.accepts.every((a: any) => a.amount === "90000")).toBe(
    true,
  );
  env.PRICE_USDC = "0.500000";
  const authorization = JSON.parse(Buffer.from(payment(), "base64").toString());
  authorization.payload.authorization.value = "90000";
  authorization.accepted.amount = "90000";
  const header = Buffer.from(JSON.stringify(authorization)).toString("base64");
  expect(
    (await post("/v1/roll", { draftToken: p.draftToken }, header)).status,
  ).toBe(200);
  expect(
    db.sqlite.prepare("SELECT amount FROM operations WHERE id=?").get(p.id),
  ).toMatchObject({ amount: "0.090000" });
  expect(
    (await post("/v1/roll", { draftToken: p.draftToken }, header)).status,
  ).toBe(200);
  expect(settlements).toBe(1);
});
it("rejects expired exact-price specifications without taking payment", async () => {
  env.PRICING_MODE = "cost";
  env.MAX_QUOTE_USDC = "1.000000";
  const p = await prepared();
  const clock = vi.spyOn(Date, "now").mockReturnValue((p.expiresAt + 1) * 1000);
  try {
    expect(
      (await post("/v1/quote/openapi", { draftToken: p.draftToken })).status,
    ).toBe(400);
    expect(settlements).toBe(0);
  } finally {
    clock.mockRestore();
  }
});
it("prepares a stateless encrypted draft and does not persist raw participant values", async () => {
  const p = await prepared();
  expect(p.status).toBe("prepared");
  expect(p.privateArchive.draft.entries).toEqual(draft.entries);
  expect(
    db.sqlite.prepare("SELECT count(*) n FROM operations").get(),
  ).toMatchObject({ n: 0 });
  expect(p.draftToken).not.toContain(draft.entries[0]);
});
it("settles once, records the operation, returns stable retries and rejects reuse across drafts", async () => {
  const p = await prepared(),
    header = payment();
  const r = await post("/v1/roll", { draftToken: p.draftToken }, header);
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).status).toBe("paid");
  expect(settlements).toBe(1);
  expect(
    (
      await post(
        "/v1/roll",
        { draftToken: p.draftToken },
        payment(hash("new-nonce")),
      )
    ).status,
  ).toBe(200);
  expect(settlements).toBe(1);
  expect((await post("/v1/roll", { draftToken: p.draftToken })).status).toBe(
    200,
  );
  expect(settlements).toBe(1);
  const other = await prepared();
  expect(
    (
      await post(
        "/v1/roll",
        { draftToken: other.draftToken },
        payment(hash("nonce"), "0x0000000000000000000000000000000000000003"),
      )
    ).status,
  ).toBe(409);
  expect(settlements).toBe(1);
  expect(reviews).toBe(1);
  const stored =
    JSON.stringify(db.sqlite.prepare("SELECT * FROM operations").all()) +
    JSON.stringify(db.sqlite.prepare("SELECT * FROM json_chunks").all());
  for (const raw of draft.entries) expect(stored).not.toContain(raw);
});
it("rejects content before settling and preserves uncertain payments without another charge", async () => {
  const p = await prepared();
  rejectReview = true;
  expect(
    (await post("/v1/roll", { draftToken: p.draftToken }, payment())).status,
  ).toBe(422);
  expect(settlements).toBe(0);
  rejectReview = false;
  settlementTimeout = true;
  expect(
    (await post("/v1/roll", { draftToken: p.draftToken }, payment())).status,
  ).toBe(503);
  expect(settlements).toBe(1);
  const retry = await post("/v1/roll", { draftToken: p.draftToken }, payment());
  expect(retry.status).toBe(202);
  expect(settlements).toBe(1);
});
it("rejects tampered draft tokens and mismatched payers before settlement", async () => {
  const p = await prepared();
  expect(
    (await post("/v1/roll", { draftToken: p.draftToken + "x" }, payment()))
      .status,
  ).toBe(400);
  const pay = JSON.parse(Buffer.from(payment(), "base64").toString());
  pay.payload.authorization.from = seller;
  expect(
    (
      await post(
        "/v1/roll",
        { draftToken: p.draftToken },
        Buffer.from(JSON.stringify(pay)).toString("base64"),
      )
    ).status,
  ).toBe(400);
  expect(settlements).toBe(0);
});

it("recovers a lost settlement response only from a fully matching Gateway transfer", async () => {
  const p = await prepared();
  settlementTimeout = true;
  expect(
    (await post("/v1/roll", { draftToken: p.draftToken }, payment())).status,
  ).toBe(503);
  db.sqlite
    .prepare("UPDATE operations SET created=?")
    .run(Math.floor(Date.now() / 1000) - 60);
  const transfer = {
    id: crypto.randomUUID(),
    status: "received",
    fromAddress: owner,
    toAddress: seller,
    amount: "100000",
    nonce: hash("nonce"),
    sendingNetwork: "eip155:5042002",
    token: "USDC",
  };
  for (const invalid of [
    {},
    { transfers: [] },
    { transfers: [{ ...transfer, toAddress: owner }] },
    { transfers: [{ ...transfer, sendingNetwork: "eip155:84532" }] },
    { transfers: [{ ...transfer, status: "unknown" }] },
  ]) {
    lookup = invalid;
    db.sqlite.prepare("UPDATE operations SET checked_at=0").run();
    await reconcilePayments(env);
    expect(
      db.sqlite.prepare("SELECT status FROM operations").get(),
    ).toMatchObject({ status: "payment_uncertain" });
  }
  lookup = { transfers: [transfer] };
  db.sqlite.prepare("UPDATE operations SET checked_at=0").run();
  await reconcilePayments(env);
  expect(
    db.sqlite.prepare("SELECT status FROM operations").get(),
  ).toMatchObject({ status: "paid" });
  expect(settlements).toBe(1);
  expect((await post("/v1/roll", { draftToken: p.draftToken })).status).toBe(
    200,
  );
  expect(settlements).toBe(1);
});

it("pauses new sales when multiple accepted payments have unresolved settlement", async () => {
  settlementTimeout = true;
  for (let i = 0; i < 3; i++) {
    const p = await prepared();
    expect(
      (
        await post(
          "/v1/roll",
          { draftToken: p.draftToken },
          payment(hash("uncertain-" + i)),
        )
      ).status,
    ).toBe(503);
  }
  db.sqlite
    .prepare("UPDATE operations SET created=?")
    .run(Math.floor(Date.now() / 1000) - 601);
  await expect(assertSalesAvailable(env)).rejects.toMatchObject({
    code: "SALES_PAUSED",
  });
  const p = await prepared();
  expect(
    (
      await post(
        "/v1/roll",
        { draftToken: p.draftToken },
        payment(hash("fourth")),
      )
    ).status,
  ).toBe(503);
  expect(settlements).toBe(3);
});

it("does not let documented payer refusals poison the global uncertainty breaker", async () => {
  settlementRefusal = "insufficient_balance";
  for (let i = 0; i < 3; i++) {
    const p = await prepared();
    expect(
      (
        await post(
          "/v1/roll",
          { draftToken: p.draftToken },
          payment(hash("refused-" + i)),
        )
      ).status,
    ).toBe(402);
  }
  db.sqlite
    .prepare("UPDATE operations SET created=?")
    .run(Math.floor(Date.now() / 1000) - 601);
  expect(
    db.sqlite
      .prepare(
        "SELECT count(*) n FROM operations WHERE status='payment_failed' AND release_block=0",
      )
      .get(),
  ).toMatchObject({ n: 3 });
  await expect(assertSalesAvailable(env)).resolves.toBeUndefined();
});

it("escalates unresolved payments without releasing reservations or capturing again", async () => {
  const p = await prepared();
  settlementTimeout = true;
  expect(
    (await post("/v1/roll", { draftToken: p.draftToken }, payment())).status,
  ).toBe(503);
  db.sqlite
    .prepare("UPDATE operations SET created=?")
    .run(Math.floor(Date.now() / 1000) - 3601);
  await reconcilePayments(env);
  expect(
    db.sqlite
      .prepare("SELECT status,release_block,error_code FROM operations")
      .get(),
  ).toMatchObject({
    status: "manual_review",
    release_block: null,
    error_code: "PAYMENT_REVIEW_REQUIRED",
  });
  const retry = await post("/v1/roll", { draftToken: p.draftToken });
  expect(retry.status).toBe(202);
  expect(((await retry.json()) as any).giveaway).toBeUndefined();
  expect(settlements).toBe(1);
});
