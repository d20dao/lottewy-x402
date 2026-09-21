import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, http, defineChain } from "viem";
const origin = "http://127.0.0.1:8788",
  rpc = "https://rpc.drpc.testnet.arc.io",
  cap = 250000n;
const secrets = parseEnv(readFileSync(".env", "utf8"));
const gateway = new GatewayClient({
  chain: "arcTestnet",
  privateKey: secrets.RELAYER_PRIVATE_KEY,
  rpcUrl: rpc,
});
const chain = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
if (
  (await createPublicClient({ chain, transport: http(rpc) }).getChainId()) !==
  5042002
)
  throw new Error("Not testnet");
gateway.onBeforePaymentCreation(({ selectedRequirements: r }) => {
  if (
    r.network !== "eip155:5042002" ||
    BigInt(r.amount) > cap ||
    r.payTo.toLowerCase() !== "0x7ad78fc8097dfea5c12dbb503d6eb6e60f34b40b"
  )
    return { abort: true, reason: "Payment exceeds this test scope" };
});
const runIndex = process.argv.indexOf("--run"),
  run = runIndex < 0 ? "local" : process.argv[runIndex + 1];
if (!run || !/^[a-z0-9-]{1,50}$/.test(run))
  throw new Error("Invalid test run identifier");
mkdirSync("artifacts", { recursive: true });
const path = `artifacts/paid-${run}-progress.json`;
const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const save = () => writeFileSync(path, JSON.stringify(state, null, 2));
const post = async (route, body) =>
  fetch(origin + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
try {
  if (!state.prepared) {
    const response = await post("/v1/giveaways", {
      owner: gateway.address,
      draft: {
        title: "Paid agent integration test",
        description: "Synthetic integration test with no prize.",
        rules:
          "Free synthetic entries. Every entry has an equal chance. No prize is awarded.",
        entries: ["Test entry Alpha", "Test entry Beta", "Test entry Gamma"],
        winners: 1,
        reserves: 1,
      },
    });
    if (!response.ok) throw new Error("Draft preparation failed");
    state.prepared = await response.json();
    save();
  }
  const challenge = await post("/v1/roll", {
    draftToken: state.prepared.draftToken,
  });
  if (challenge.status === 402) {
    const requirements = JSON.parse(
      Buffer.from(
        challenge.headers.get("payment-required"),
        "base64",
      ).toString(),
    );
    const terms = requirements.accepts.find(
      (r) => r.network === "eip155:5042002",
    );
    if (!terms || BigInt(terms.amount) > cap)
      throw new Error("Unexpected advertised test price");
    console.log({
      testOnly: true,
      priceMicroUsdc: terms.amount,
      buyer: gateway.address,
    });
    let balances = await gateway.getBalances();
    if (balances.gateway.available < BigInt(terms.amount)) {
      if (state.depositStarted && !state.deposit)
        throw new Error(
          "An earlier deposit needs reconciliation; refusing another",
        );
      if (!state.deposit) {
        state.depositStarted = true;
        save();
        const deposit = await gateway.deposit("0.25", {
          approveAmount: "0.25",
        });
        state.deposit = {
          transaction: deposit.depositTxHash,
          approval: deposit.approvalTxHash,
        };
        save();
        console.log({ deposit: state.deposit.transaction });
      }
      for (
        let i = 0;
        i < 24 && balances.gateway.available < BigInt(terms.amount);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 2000));
        balances = await gateway.getBalances();
      }
      if (balances.gateway.available < BigInt(terms.amount))
        throw new Error(
          "Deposit is still crediting; retry this saved test later",
        );
    }
    const result = await gateway.pay(origin + "/v1/roll", {
      method: "POST",
      body: { draftToken: state.prepared.draftToken },
    });
    state.paid = {
      status: result.status,
      amount: result.amount.toString(),
      settlement: result.transaction,
      id: result.data.id,
    };
    save();
    console.log({
      paidStatus: result.status,
      amountMicroUsdc: result.amount.toString(),
      operation: result.data.id,
    });
  } else if (!challenge.ok)
    throw new Error(
      "Original operation requires investigation: HTTP " + challenge.status,
    );
  for (let i = 0; i < 30; i++) {
    const response = await fetch(origin + "/v1/giveaways/" + state.prepared.id),
      result = await response.json();
    state.lastStatus = result.status;
    save();
    if (result.status === "completed") {
      const proofResponse = await fetch(
        origin + "/v1/giveaways/" + state.prepared.id + "/proof",
      );
      if (!proofResponse.ok) throw new Error("Proof verification failed");
      const proof = await proofResponse.json();
      state.requestId = proof.onchain.requestId;
      state.proofVerified = true;
      save();
      writeFileSync(
        `artifacts/paid-${run}-public-proof.json`,
        JSON.stringify(proof, null, 2),
      );
      console.log({
        completed: true,
        id: state.prepared.id,
        requestId: state.requestId,
        proofVerified: true,
      });
      process.exit(0);
    }
    if (
      [
        "manual_review",
        "payment_uncertain",
        "payment_failed",
        "refund_due",
        "expired",
      ].includes(result.status)
    )
      throw new Error("Original operation needs recovery: " + result.status);
    await fetch(origin + "/cdn-cgi/local/scheduled");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Operation is still pending; resume this same test");
} catch (error) {
  console.error({
    testFailed: true,
    message: error instanceof Error ? error.message : "Unknown failure",
    operation: state.prepared?.id,
  });
  process.exitCode = 1;
}
