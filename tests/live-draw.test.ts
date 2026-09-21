import { it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { database } from "./d1";
import { executionPlan, processJobs, relayer, chainClient } from "../src/chain";
import { prepare, openTicket, materialize } from "../src/tickets";
import { verifyD20 } from "../src/protocol/shared/proof";
import deployment from "../src/protocol/docs/lottewy-testnet.json";

it.skipIf(process.env.LIVE_DRAW_CHECK !== "1")(
  "executes one explicitly gated synthetic testnet draw and verifies its public proof",
  async () => {
    const env = {
      ...parseEnv(readFileSync(".env", "utf8")),
      ...JSON.parse(
        readFileSync("wrangler.jsonc", "utf8").replace(/,\s*([}\]])/g, "$1"),
      ).vars,
    } as any;
    env.DB = database();
    // Contract integration budget only; this does not change the advertised API price.
    env.PRICE_USDC = "0.250000";
    mkdirSync("artifacts", { recursive: true });
    const stateFile = "artifacts/live-draw-operation.json";
    let op: any;
    if (existsSync(stateFile)) op = JSON.parse(readFileSync(stateFile, "utf8"));
    else {
      const p = await prepare(env, {
        owner: deployment.owner,
        draft: {
          title: "V2 synthetic verification",
          description: "Synthetic contract integration test. No prize.",
          rules:
            "Free synthetic entries. Weights are public. This test does not award a prize.",
          entries: [
            "Test participant 1",
            "Test participant 2",
            "Test participant 3",
          ],
          weights: [1, 2, 3],
          winners: 2,
          reserves: 1,
        },
      });
      const ticket = await openTicket(env, p.draftToken),
        built = materialize(ticket),
        plan = await executionPlan(env, ticket);
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
        refundAddress: relayer(env).address,
        execution: plan,
        review: {
          mode: "synthetic",
          model: "none",
          policy: "contract-integration-test-only",
        },
      };
      op = {
        id: g.id,
        owner: g.owner,
        commitment: g.commitment,
        payment_key: "contract-smoke-" + g.id,
        status: "paid",
        public_json: JSON.stringify(g),
        created: g.created,
        amount: "0",
        payment_network: "none",
        payment_ref: "{}",
        review_json: "{}",
        reserved_units: plan.reservedUnits,
      };
      writeFileSync(stateFile, JSON.stringify(op));
    }
    if (
      op.status === "refund_due" &&
      op.error_code === "DRAW_REVERTED" &&
      process.env.LIVE_DRAW_RETRY_REVERTED === "1"
    ) {
      const client = await chainClient(env),
        receipt = await client.getTransactionReceipt({ hash: op.tx_hash });
      const finalized = await client.getBlock({ blockTag: "finalized" }),
        canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      expect(receipt.status).toBe("reverted");
      expect(receipt.blockHash).toBe(canonical.hash);
      expect(receipt.blockNumber <= finalized.number).toBe(true);
      const g = JSON.parse(op.public_json),
        plan = await executionPlan(env, {
          id: op.id,
          owner: op.owner,
          commitment: op.commitment,
        } as any);
      g.execution = plan;
      op = {
        ...op,
        status: "paid",
        public_json: JSON.stringify(g),
        reserved_units: plan.reservedUnits,
        release_block: null,
        tx_hash: null,
        raw_tx: null,
        tx_nonce: null,
        error_code: null,
      };
      writeFileSync(stateFile, JSON.stringify(op));
    }
    const fields = Object.keys(op);
    env.DB.sqlite
      .prepare(
        `INSERT INTO operations(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`,
      )
      .run(...fields.map((k) => op[k]));
    // Flush every journal mutation to disk before a possible broadcast, so rerunning this paid
    // chain test resumes the same transaction identity instead of opening another draw.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      const statement = realPrepare(sql),
        run = statement.run.bind(statement);
      statement.run = async () => {
        const result = await run();
        const row = env.DB.sqlite
          .prepare("SELECT * FROM operations WHERE id=?")
          .get(op.id);
        if (row) writeFileSync(stateFile, JSON.stringify(row));
        return result;
      };
      return statement;
    };
    for (let i = 0; i < 24; i++) {
      await processJobs(env);
      op = env.DB.sqlite.prepare("SELECT * FROM operations").get();
      if (op.status === "completed") break;
      if (["refund_due", "expired"].includes(op.status))
        throw new Error("Synthetic draw needs recovery: " + op.status);
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(op.status).toBe("completed");
    const g = JSON.parse(op.public_json),
      proof = await verifyD20(g, env.RPC_URL);
    expect(proof.valid).toBe(true);
    writeFileSync(
      "artifacts/live-draw-public-giveaway.json",
      JSON.stringify(g, null, 2) + "\n",
    );
    console.log({
      giveawayId: g.id,
      requestId: g.evidence.requestId,
      transaction: g.evidence.txHash,
      proofVerified: proof.valid,
    });
    env.DB.sqlite.close();
  },
  180000,
);
