import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { hash } from "../src/protocol/shared/core";
import deployment from "../src/protocol/docs/lottewy-testnet.json";
import d20 from "../src/protocol/docs/arc-testnet.json";
import { database } from "./d1";

const fakes = vi.hoisted(() => ({
  client: undefined as any,
  wallet: undefined as any,
  codeByAddress: new Map<string, string>(),
  codeHashByCode: new Map<string, string>(),
  draw: undefined as any,
  request: undefined as any,
  requested: undefined as any,
  fulfilled: undefined as any,
  finalized: undefined as any,
  receipts: new Map<string, any>(),
  sentRaw: [] as string[],
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    keccak256: (value: any) =>
      fakes.codeHashByCode.get(String(value)) ?? actual.keccak256(value),
    createPublicClient: vi.fn(() => fakes.client),
    createWalletClient: vi.fn(() => fakes.wallet),
    http: vi.fn(() => ({})),
  };
});

vi.mock("../src/recovery", () => ({
  processRecovery: vi.fn(async () => false),
}));

import { processJobs } from "../src/chain";
import type { Env } from "../src/config";

const owner = "0x0000000000000000000000000000000000000011";
const consumer = "0x00000000000000000000000000000000000000cc";
const refundAddress = "0x00000000000000000000000000000000000000f1";
const blockHash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const txHash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const slotValue = (address: string) =>
  `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

function makeEnvironment() {
  const db = database();
  const env = {
    DB: db as any,
    PUBLIC_ORIGIN: "https://api.example.test",
    WEB_ORIGIN: "https://web.example.test",
    SUPPORT_EMAIL: "support@example.test",
    SELLER_ADDRESS: "0x0000000000000000000000000000000000000022",
    RELAYER_PRIVATE_KEY: generatePrivateKey(),
    DRAFT_SECRET: "11".repeat(32),
    RPC_URL: "http://rpc.example.test",
    CONSUMER_ADDRESS: consumer,
    CONSUMER_CODE_HASH: blockHash("1"),
    IMPLEMENTATION_ADDRESS: "0x00000000000000000000000000000000000000dd",
    IMPLEMENTATION_CODE_HASH: blockHash("2"),
    PRICE_USDC: "0.100000",
    GAS_LIMIT: "350000",
    JEV_MODEL: "test",
    JEV_MODE: "live",
    MODE: "production",
  } as unknown as Env;

  const consumerCode = "0x6001";
  const implementationCode = "0x6002";
  const coordinatorCode = "0x6003";
  const epochCode = "0x6004";
  fakes.codeByAddress.clear();
  fakes.codeHashByCode.clear();
  fakes.codeByAddress.set(env.CONSUMER_ADDRESS.toLowerCase(), consumerCode);
  fakes.codeByAddress.set(
    env.IMPLEMENTATION_ADDRESS.toLowerCase(),
    implementationCode,
  );
  fakes.codeByAddress.set(
    d20.coordinatorImplementation.toLowerCase(),
    coordinatorCode,
  );
  fakes.codeByAddress.set(d20.epochImplementation.toLowerCase(), epochCode);
  fakes.codeHashByCode.set(consumerCode, env.CONSUMER_CODE_HASH);
  fakes.codeHashByCode.set(implementationCode, env.IMPLEMENTATION_CODE_HASH);
  fakes.codeHashByCode.set(
    coordinatorCode,
    d20.coordinatorImplementationCodeHash,
  );
  fakes.codeHashByCode.set(epochCode, d20.epochImplementationCodeHash);

  fakes.sentRaw.length = 0;
  fakes.finalized = {
    number: 200n,
    hash: blockHash("9"),
    timestamp: 1_000n,
    baseFeePerGas: 1n,
  };
  fakes.receipts.clear();
  fakes.client = {
    getChainId: async () => 5_042_002,
    getCode: async ({ address }: { address: string }) =>
      fakes.codeByAddress.get(address.toLowerCase()) ?? "0x",
    getStorageAt: async ({ address }: { address: string }) => {
      const lower = address.toLowerCase();
      if (lower === env.CONSUMER_ADDRESS.toLowerCase())
        return slotValue(env.IMPLEMENTATION_ADDRESS);
      if (lower === d20.coordinator.toLowerCase())
        return slotValue(d20.coordinatorImplementation);
      if (lower === d20.registry.toLowerCase())
        return slotValue(d20.epochImplementation);
      return `0x${"0".repeat(64)}`;
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "coordinator")
        return "0xd20DA0FF9087d053f0291524Eac12abA1ADBd945";
      if (functionName === "draws") return fakes.draw;
      if (functionName === "getRequest") return fakes.request;
      throw new Error(`unexpected readContract ${functionName}`);
    },
    getBlock: async (args: any) => {
      if (args.blockTag === "finalized") return fakes.finalized;
      return {
        number: args.blockNumber,
        hash: args.blockNumber === 100n ? blockHash("3") : blockHash("4"),
        timestamp: 1_000n,
      };
    },
    getContractEvents: async ({ eventName }: { eventName: string }) =>
      eventName === "DrawRequested"
        ? [fakes.requested]
        : eventName === "DrawFulfilled"
          ? [fakes.fulfilled]
          : [],
    getTransactionReceipt: async ({ hash }: { hash: string }) =>
      fakes.receipts.get(hash) ?? null,
    getTransactionCount: async () => 7n,
    getBalance: async () => 1_000_000_000_000_000_000n,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: string;
    }) => {
      fakes.sentRaw.push(serializedTransaction);
      return txHash("e");
    },
  };
  fakes.wallet = {
    prepareTransactionRequest: vi.fn(async (request: any) => request),
    signTransaction: vi.fn(async () => `0x02${"00".repeat(32)}`),
  };
  return { db, env };
}

function insertOperation(
  db: ReturnType<typeof database>,
  input: {
    id: string;
    status: string;
    commitment: `0x${string}`;
    publicJson: string;
    observedBlock?: number;
  },
) {
  db.sqlite
    .prepare(
      `INSERT INTO operations(
        id,owner,commitment,payment_key,status,public_json,created,amount,
        payment_network,payment_ref,review_json,reserved_units,checked_at,observed_block
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.id,
      owner,
      input.commitment,
      `payment-${input.id}`,
      input.status,
      input.publicJson,
      Math.floor(Date.now() / 1000) - 60,
      "0.100000",
      "eip155:5042002",
      "{}",
      "{}",
      1,
      0,
      input.observedBlock ?? 0,
    );
}

function configureCompletedDraw(
  env: Env,
  id: string,
  commitment: `0x${string}`,
) {
  const requestId = 77n;
  const word = hash("random-word");
  const requestTx = txHash("a");
  const fulfillmentTx = txHash("b");
  fakes.draw = [owner, commitment, requestId, word, 2];
  fakes.request = {
    consumer: env.CONSUMER_ADDRESS,
    clientSeed: commitment,
    refundAddress,
    requestBlock: 100n,
    targetBlock: 101n,
    deadline: 2_000n,
    fulfilled: true,
    delivered: true,
    refunded: false,
    randomness: word,
  };
  fakes.requested = {
    args: { requestId, commitment },
    transactionHash: requestTx,
    blockHash: blockHash("3"),
    blockNumber: 100n,
    logIndex: 0,
  };
  fakes.fulfilled = {
    args: { requestId, word },
    transactionHash: fulfillmentTx,
    blockHash: blockHash("4"),
    blockNumber: 110n,
    logIndex: 1,
  };
  fakes.receipts.set(requestTx, {
    status: "success",
    transactionHash: requestTx,
    blockHash: blockHash("3"),
    blockNumber: 100n,
  });
  fakes.receipts.set(fulfillmentTx, {
    status: "success",
    transactionHash: fulfillmentTx,
    blockHash: blockHash("4"),
    blockNumber: 110n,
  });
  return { requestId, word };
}

describe("chain worker state transitions", () => {
  it("quarantines a direct-start binding conflict so the next paid draw can complete", async () => {
    const { db, env } = makeEnvironment(),
      bad = "conflicted",
      good = "next-paid";
    const badCommitment = hash(bad),
      goodCommitment = hash(good);
    configureCompletedDraw(env, bad, badCommitment);
    fakes.request.refundAddress = owner;
    insertOperation(db, {
      id: bad,
      status: "paid",
      commitment: badCommitment,
      publicJson: JSON.stringify({
        id: bad,
        owner,
        refundAddress,
        manifest: {},
      }),
    });
    await processJobs(env);
    expect(
      db.sqlite
        .prepare(
          "SELECT status,error_code,request_id,release_block FROM operations WHERE id=?",
        )
        .get(bad),
    ).toMatchObject({
      status: "binding_conflict",
      error_code: "DRAW_BINDING_CONFLICT",
      request_id: null,
      release_block: 0,
    });
    configureCompletedDraw(env, good, goodCommitment);
    insertOperation(db, {
      id: good,
      status: "paid",
      commitment: goodCommitment,
      publicJson: JSON.stringify({
        id: good,
        owner,
        refundAddress,
        manifest: {},
      }),
    });
    await processJobs(env);
    expect(
      db.sqlite.prepare("SELECT status FROM operations WHERE id=?").get(good),
    ).toMatchObject({ status: "completed" });
    expect(fakes.sentRaw).toHaveLength(0);
  });

  it("keeps driving a journaled nonce until its canonical receipt before quarantining conflict", async () => {
    const { db, env } = makeEnvironment(),
      id = "pending-conflict",
      commitment = hash(id),
      ownHash = txHash("e");
    configureCompletedDraw(env, id, commitment);
    fakes.request.refundAddress = owner;
    insertOperation(db, {
      id,
      status: "submitting",
      commitment,
      publicJson: JSON.stringify({ id, owner, refundAddress, manifest: {} }),
    });
    db.sqlite
      .prepare("UPDATE operations SET raw_tx=?,tx_hash=?,tx_nonce=7 WHERE id=?")
      .run("0x02", ownHash, id);
    await processJobs(env);
    expect(fakes.sentRaw).toEqual(["0x02"]);
    expect(
      db.sqlite.prepare("SELECT status,release_block FROM operations").get(),
    ).toMatchObject({ status: "submitting", release_block: null });
    fakes.receipts.set(ownHash, {
      status: "reverted",
      blockNumber: 120n,
      blockHash: blockHash("4"),
    });
    await processJobs(env);
    expect(
      db.sqlite.prepare("SELECT status,release_block FROM operations").get(),
    ).toMatchObject({ status: "binding_conflict", release_block: 120 });
    expect(fakes.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("finds delayed callback delivery in the historical middle gap with persisted bounded pages", async () => {
    const { db, env } = makeEnvironment(),
      id = "delayed-callback",
      commitment = hash(id);
    configureCompletedDraw(env, id, commitment);
    fakes.finalized.number = 5000n;
    fakes.fulfilled.blockNumber = 2500n;
    fakes.receipts.get(fakes.fulfilled.transactionHash).blockNumber = 2500n;
    const pages: bigint[][] = [];
    fakes.client.getContractEvents = async ({
      eventName,
      fromBlock,
      toBlock,
    }: any) => {
      if (eventName === "DrawRequested") return [fakes.requested];
      pages.push([fromBlock, toBlock]);
      return fromBlock <= 2500n && toBlock >= 2500n ? [fakes.fulfilled] : [];
    };
    insertOperation(db, {
      id,
      status: "paid",
      commitment,
      publicJson: JSON.stringify({ id, owner, refundAddress, manifest: {} }),
    });
    await processJobs(env);
    expect(
      db.sqlite
        .prepare(
          "SELECT status,fulfillment_scan_block,release_block,request_id FROM operations",
        )
        .get(),
    ).toMatchObject({
      status: "waiting",
      fulfillment_scan_block: 2100,
      release_block: 100,
      request_id: "77",
    });
    db.sqlite.prepare("UPDATE operations SET checked_at=0").run();
    await processJobs(env);
    expect(
      db.sqlite.prepare("SELECT status FROM operations").get(),
    ).toMatchObject({ status: "completed" });
    expect(pages).toEqual([
      [100n, 2099n],
      [2100n, 4099n],
    ]);
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a finalized completed draw and leaves it terminal on an older pass", async () => {
    const { db, env } = makeEnvironment();
    const id = "11111111-1111-4111-8111-111111111111";
    const commitment = hash("completed-commitment");
    const g = {
      id,
      owner,
      status: "waiting",
      refundAddress,
      commitment,
      manifest: {},
    };
    const { requestId, word } = configureCompletedDraw(env, id, commitment);
    insertOperation(db, {
      id,
      status: "waiting",
      commitment,
      publicJson: JSON.stringify(g),
    });

    await processJobs(env);
    const first = db.sqlite
      .prepare(
        "SELECT status,public_json,observed_block FROM operations WHERE id=?",
      )
      .get(id) as any;
    expect(first.status).toBe("completed");
    expect(first.observed_block).toBe(200);
    expect(JSON.parse(first.public_json)).toMatchObject({
      status: "completed",
      evidence: { requestId: requestId.toString(), word },
    });

    // A later scheduler pass must not reopen a terminal operation, even if its
    // RPC snapshot is older than the block that produced completion.
    fakes.finalized = { ...fakes.finalized, number: 150n };
    await processJobs(env);
    const second = db.sqlite
      .prepare(
        "SELECT status,public_json,observed_block FROM operations WHERE id=?",
      )
      .get(id) as any;
    expect(second.status).toBe("completed");
    expect(second.observed_block).toBe(200);
    expect(JSON.parse(second.public_json)).toMatchObject({
      status: "completed",
      evidence: { requestId: requestId.toString() },
    });
    expect(fakes.sentRaw).toHaveLength(0);
  });

  it("never broadcasts a raw draw transaction before its journal update commits", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, env } = makeEnvironment();
    const id = "22222222-2222-4222-8222-222222222222";
    const commitment = hash("journal-commitment");
    fakes.draw = [owner, commitment, 0n, hash("unused"), 0];
    insertOperation(db, {
      id,
      status: "paid",
      commitment,
      publicJson: JSON.stringify({
        id,
        owner,
        status: "paid",
        refundAddress,
        commitment,
        manifest: {},
        execution: { value: "0", gas: "21000", maxFeePerGas: "1" },
      }),
    });

    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      const statement = realPrepare(sql);
      if (sql.includes("SET raw_tx=?"))
        statement.run = async () => {
          throw new Error("journal unavailable");
        };
      return statement;
    }) as typeof env.DB.prepare;

    await processJobs(env);
    const row = db.sqlite
      .prepare(
        "SELECT status,raw_tx,tx_hash,tx_nonce FROM operations WHERE id=?",
      )
      .get(id) as any;
    expect(row.status).toBe("paid");
    expect(row.raw_tx).toBeNull();
    expect(row.tx_hash).toBeNull();
    expect(row.tx_nonce).toBeNull();
    expect(fakes.sentRaw).toHaveLength(0);
  });
});
