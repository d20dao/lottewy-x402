import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hash } from "../src/protocol/shared/core";
import { database } from "./d1";
import { lease } from "../src/store";
const fake = vi.hoisted(() => ({ sign: vi.fn(), prepare: vi.fn() }));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createWalletClient: () => ({
    prepareTransactionRequest: fake.prepare,
    signTransaction: fake.sign,
  }),
}));
import { processRecovery } from "../src/recovery";
let db: ReturnType<typeof database>,
  env: any,
  client: any,
  token: string,
  receipt: any,
  broadcasts: number;
const id = "synthetic-recovery",
  commitment = hash("committed list"),
  consumer = "0x0000000000000000000000000000000000000001";
beforeEach(async () => {
  db = database();
  receipt = null;
  broadcasts = 0;
  const key = generatePrivateKey(),
    payer = privateKeyToAccount(key).address;
  env = {
    DB: db,
    RELAYER_PRIVATE_KEY: key,
    RPC_URL: "http://unused",
    CONSUMER_ADDRESS: consumer,
  };
  db.sqlite
    .prepare(
      "INSERT INTO operations(id,owner,commitment,payment_key,status,public_json,created,amount,payment_network,payment_ref,review_json,reserved_units,release_block,request_id) VALUES(?,?,?,?,'callback',?,0,'0.15','test','{}','{}',100000,1,'42')",
    )
    .run(
      id,
      payer.toLowerCase(),
      commitment,
      "payment",
      JSON.stringify({ refundAddress: payer }),
    );
  token = (await lease(env, "relayer"))!;
  fake.prepare.mockImplementation(async (x) => x);
  fake.sign.mockResolvedValue("0x02");
  client = {
    getBlock: vi.fn(async ({ blockNumber }: any) => ({
      number: blockNumber ?? 10n,
      hash: hash("canonical"),
      timestamp: 100n,
    })),
    readContract: vi.fn(async () => ({
      consumer,
      clientSeed: commitment,
      refundAddress: payer,
      fulfilled: true,
      delivered: false,
      refunded: false,
      deadline: 50n,
    })),
    estimateGas: vi.fn(async () => 100000n),
    getGasPrice: vi.fn(async () => 1000000000n),
    getBalance: vi.fn(async () => 1000000000000000000n),
    getTransactionCount: vi.fn(async () => 3),
    getTransactionReceipt: vi.fn(async () => {
      if (!receipt) throw new Error("Not found");
      return receipt;
    }),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: any) => {
      expect(
        db.sqlite
          .prepare("SELECT raw_tx,status FROM recovery_transactions")
          .get(),
      ).toMatchObject({ raw_tx: serializedTransaction, status: "pending" });
      broadcasts++;
      return hash("broadcast");
    }),
  };
});
afterEach(() => {
  db.sqlite.close();
  vi.clearAllMocks();
});
it("journals before broadcast and retries only the saved recovery transaction", async () => {
  expect(await processRecovery(env, client, token, false)).toBe(true);
  expect(fake.sign).toHaveBeenCalledTimes(1);
  expect(broadcasts).toBe(1);
  expect(await processRecovery(env, client, token, false)).toBe(true);
  expect(fake.sign).toHaveBeenCalledTimes(1);
  expect(broadcasts).toBe(2);
  receipt = {
    status: "success",
    blockNumber: 5n,
    blockHash: hash("canonical"),
  };
  await processRecovery(env, client, token, false);
  expect(
    db.sqlite
      .prepare("SELECT status,release_block FROM recovery_transactions")
      .get(),
  ).toMatchObject({ status: "completed", release_block: 5 });
  expect(await processRecovery(env, client, token, false)).toBe(false);
  expect(fake.sign).toHaveBeenCalledTimes(1);
});
it("does not reserve another nonce while a draw is submitting or the lease has expired", async () => {
  expect(await processRecovery(env, client, token, true)).toBe(false);
  expect(fake.sign).not.toHaveBeenCalled();
  db.sqlite.prepare("UPDATE leases SET expires=0 WHERE name='relayer'").run();
  expect(await processRecovery(env, client, token, false)).toBe(false);
  expect(broadcasts).toBe(0);
  expect(
    db.sqlite.prepare("SELECT count(*) n FROM recovery_transactions").get(),
  ).toMatchObject({ n: 0 });
});
it("skips unjournaled recovery when liquidity is already reserved for paid draws", async () => {
  db.sqlite
    .prepare(
      `INSERT INTO operations(id,owner,commitment,payment_key,status,public_json,created,amount,payment_network,payment_ref,review_json,reserved_units)
    SELECT 'funded-next',owner,commitment,'next-payment','paid',public_json,created,amount,payment_network,payment_ref,review_json,1000000 FROM operations LIMIT 1`,
    )
    .run();
  expect(await processRecovery(env, client, token, false)).toBe(false);
  expect(broadcasts).toBe(0);
  expect(
    db.sqlite.prepare("SELECT count(*) n FROM recovery_transactions").get(),
  ).toMatchObject({ n: 0 });
});
it("adopts a recovery journal when its commit acknowledgement is lost", async () => {
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements: any[]) => {
    await realBatch(statements);
    throw new Error("Lost response");
  };
  expect(await processRecovery(env, client, token, false)).toBe(true);
  expect(broadcasts).toBe(1);
  expect(fake.sign).toHaveBeenCalledTimes(1);
});
it("never refunds an already fulfilled request and enforces a recovery expense cap", async () => {
  db.sqlite.prepare("UPDATE operations SET status='refund_due'").run();
  expect(await processRecovery(env, client, token, false)).toBe(false);
  client.readContract.mockResolvedValue({
    ...(await client.readContract()),
    fulfilled: false,
  });
  env.RECOVERY_MAX_USDC = "0.000001";
  expect(await processRecovery(env, client, token, false)).toBe(false);
  expect(broadcasts).toBe(0);
});
