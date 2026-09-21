import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, consumerAbi, coordinatorAbi } from "./protocol/shared/chain";
import {
  COORDINATOR,
  CHAIN_ID,
  hash,
  select,
  type Giveaway,
} from "./protocol/shared/core";
import { ApiError, type Env } from "./config";
import { lease, release, operation, type Operation } from "./store";
import type { Ticket } from "./tickets";
import d20 from "./protocol/docs/arc-testnet.json";
import { reconcilePayments } from "./settlement";
import { processRecovery } from "./recovery";
export const agentAbi = [
  ...consumerAbi,
  ...parseAbi([
    "function startSponsored(address owner,bytes32 giveawayId,bytes32 commitment,uint256 maxFee) payable returns(uint256)",
    "function relayers(address) view returns(bool)",
  ]),
];
const slot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const MICRO = 1000000000000n;
export function relayer(env: Env) {
  return privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
}
export async function chainClient(env: Env) {
  const client = createPublicClient({
    chain: arc,
    transport: http(env.RPC_URL, { timeout: 12000, retryCount: 1 }),
  });
  if ((await client.getChainId()) !== CHAIN_ID)
    throw new ApiError(
      503,
      "CHAIN_UNAVAILABLE",
      "Only Arc Testnet is supported",
    );
  const address = env.CONSUMER_ADDRESS as Address;
  const [code, implementationSlot, implementationCode, coordinator] =
    await Promise.all([
      client.getCode({ address }),
      client.getStorageAt({ address, slot }),
      client.getCode({ address: env.IMPLEMENTATION_ADDRESS as Address }),
      client.readContract({
        address,
        abi: agentAbi,
        functionName: "coordinator",
      }),
    ]);
  if (
    !code ||
    keccak256(code) !== env.CONSUMER_CODE_HASH ||
    implementationSlot?.slice(-40).toLowerCase() !==
      env.IMPLEMENTATION_ADDRESS.slice(2).toLowerCase() ||
    !implementationCode ||
    keccak256(implementationCode) !== env.IMPLEMENTATION_CODE_HASH ||
    coordinator.toLowerCase() !== COORDINATOR.toLowerCase()
  )
    throw new ApiError(
      503,
      "DEPLOYMENT_MISMATCH",
      "The configured contract deployment could not be verified",
    );
  for (const [proxy, implementation, expected] of [
    [
      d20.coordinator,
      d20.coordinatorImplementation,
      d20.coordinatorImplementationCodeHash,
    ],
    [d20.registry, d20.epochImplementation, d20.epochImplementationCodeHash],
  ]) {
    const [current, code] = await Promise.all([
      client.getStorageAt({ address: proxy as Address, slot }),
      client.getCode({ address: implementation as Address }),
    ]);
    if (
      current?.slice(-40).toLowerCase() !==
        implementation.slice(2).toLowerCase() ||
      !code ||
      keccak256(code) !== expected
    )
      throw new ApiError(
        503,
        "DEPLOYMENT_MISMATCH",
        "D20DAO deployment changed; execution is paused pending review",
      );
  }
  return client;
}
export async function executionPlan(env: Env, ticket: Ticket) {
  const client = await chainClient(env),
    account = relayer(env),
    address = env.CONSUMER_ADDRESS as Address;
  const block = await client.getBlock({ blockTag: "finalized" });
  if (block.number === null || block.baseFeePerGas === null)
    throw new ApiError(
      503,
      "FINALITY_UNAVAILABLE",
      "Finalized chain state is unavailable",
    );
  const key = keccak256(
    encodeAbiParameters(parseAbiParameters("address,bytes32"), [
      ticket.owner,
      hash(ticket.id),
    ]),
  );
  const [balance, authorized, draw, value, gasPrice] = await Promise.all([
    client.getBalance({ address: account.address, blockNumber: block.number }),
    client.readContract({
      address,
      abi: agentAbi,
      functionName: "relayers",
      args: [account.address],
      blockNumber: block.number,
    }),
    client.readContract({
      address,
      abi: agentAbi,
      functionName: "draws",
      args: [key],
      blockNumber: block.number,
    }),
    client.readContract({
      address: COORDINATOR,
      abi: coordinatorAbi,
      functionName: "quoteFeeAt",
      args: [150000, (block.baseFeePerGas * 130n) / 100n],
      blockNumber: block.number,
    }),
    client.getGasPrice(),
  ]);
  if (!authorized)
    throw new ApiError(
      503,
      "RELAYER_UNAVAILABLE",
      "The API relayer is not authorized",
    );
  if (draw[4] !== 0)
    throw new ApiError(
      409,
      "DRAW_EXISTS",
      "This giveaway already has an onchain request",
    );
  const estimated = await client.estimateContractGas({
    address,
    abi: agentAbi,
    functionName: "startSponsored",
    args: [ticket.owner, hash(ticket.id), ticket.commitment, value],
    account: account.address,
    value,
  });
  const gas = (estimated * 120n + 99n) / 100n;
  if (gas > BigInt(env.GAS_LIMIT))
    throw new ApiError(
      503,
      "EXECUTION_GAS_LIMIT",
      "The draw exceeds the configured execution gas cap. No payment was captured.",
    );
  const maxFeePerGas = gasPrice * 2n,
    budget = value + gas * maxFeePerGas,
    price = parseUnits(env.PRICE_USDC, 6) * MICRO;
  if (budget > price)
    throw new ApiError(
      503,
      "PRICE_TOO_LOW",
      "Execution currently exceeds the advertised price. No payment was captured.",
    );
  if (balance < budget)
    throw new ApiError(
      503,
      "RELAYER_LIQUIDITY",
      "The relayer is temporarily low on testnet USDC. No payment was captured.",
    );
  return {
    value: value.toString(),
    gas: gas.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    reservedUnits: Number((budget + MICRO - 1n) / MICRO),
    balanceUnits: Number(balance / MICRO),
    blockNumber: Number(block.number),
  };
}
async function observe(
  env: Env,
  op: Operation,
  client: Awaited<ReturnType<typeof chainClient>>,
  token: string,
) {
  const block = await client.getBlock({ blockTag: "finalized" }),
    g = JSON.parse(op.public_json) as Giveaway,
    address = env.CONSUMER_ADDRESS as Address;
  const key = keccak256(
    encodeAbiParameters(parseAbiParameters("address,bytes32"), [
      op.owner as Address,
      hash(op.id),
    ]),
  );
  const draw = await client.readContract({
    address,
    abi: agentAbi,
    functionName: "draws",
    args: [key],
    blockNumber: block.number,
  });
  if (draw[4] === 0) return false;
  async function quarantineConflict() {
    let releaseBlock = 0;
    // A journaled transaction may still consume this nonce and gas. Keep driving
    // those exact bytes until its canonical receipt exists before removing it.
    if (op.raw_tx) {
      const own = await client
        .getTransactionReceipt({ hash: op.tx_hash! })
        .catch(() => null);
      if (!own || own.blockNumber > block.number) return false;
      const canonical = await client.getBlock({ blockNumber: own.blockNumber });
      if (canonical.hash !== own.blockHash) return false;
      releaseBlock = Number(own.blockNumber);
    }
    await env.DB.prepare(
      `UPDATE operations SET status='binding_conflict',error_code='DRAW_BINDING_CONFLICT',request_id=NULL,
      release_block=?,checked_at=MAX(checked_at,?),observed_block=? WHERE id=?
      AND status IN ('paid','submitting','waiting','callback','refund_due') AND observed_block<=?
      AND EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)`,
    )
      .bind(
        releaseBlock,
        Date.now(),
        Number(block.number),
        op.id,
        Number(block.number),
        token,
        Date.now(),
      )
      .run();
    return true;
  }
  if (draw[0].toLowerCase() !== op.owner || draw[1] !== op.commitment)
    return quarantineConflict();
  const req = await client.readContract({
    address: COORDINATOR,
    abi: coordinatorAbi,
    functionName: "getRequest",
    args: [draw[2]],
    blockNumber: block.number,
  });
  if (
    req.consumer.toLowerCase() !== address.toLowerCase() ||
    req.clientSeed !== op.commitment ||
    req.refundAddress.toLowerCase() !== g.refundAddress?.toLowerCase()
  )
    return quarantineConflict();
  const requests = await client.getContractEvents({
    address,
    abi: agentAbi,
    eventName: "DrawRequested",
    args: { key },
    fromBlock: req.requestBlock,
    toBlock: req.requestBlock,
  });
  const request = requests.find(
    (log) =>
      log.args.requestId === draw[2] && log.args.commitment === op.commitment,
  );
  if (!request) throw new Error("Request receipt unavailable");
  const receipt = await client.getTransactionReceipt({
    hash: request.transactionHash,
  });
  if (
    receipt.status !== "success" ||
    receipt.blockHash !== request.blockHash ||
    receipt.blockNumber > block.number
  )
    throw new Error("Request not finalized");
  let spentBlock = Number(req.requestBlock);
  if (op.raw_tx && op.tx_hash !== request.transactionHash) {
    const own = await client
      .getTransactionReceipt({ hash: op.tx_hash! })
      .catch(() => null);
    if (!own || own.blockNumber > block.number) return false;
    const canonical = await client.getBlock({ blockNumber: own.blockNumber });
    if (canonical.hash !== own.blockHash) return false;
    spentBlock = Math.max(spentBlock, Number(own.blockNumber));
  }
  let status = req.refunded
    ? "expired"
    : req.fulfilled && !req.delivered
      ? "callback"
      : !req.fulfilled && req.deadline < block.timestamp
        ? "refund_due"
        : "waiting";
  if (draw[4] === 2) {
    if (!req.fulfilled || !req.delivered || req.randomness !== draw[3])
      throw new Error("Randomness binding mismatch");
    const cursor = BigInt(
      op.fulfillment_scan_block ?? Number(req.requestBlock),
    );
    const start = cursor > req.requestBlock ? cursor : req.requestBlock;
    if (start > block.number) return true;
    const end = start + 1999n < block.number ? start + 1999n : block.number;
    const delivered = await client.getContractEvents({
      address,
      abi: agentAbi,
      eventName: "DrawFulfilled",
      args: { key, requestId: draw[2] },
      fromBlock: start,
      toBlock: end,
    });
    const event = delivered.find((log) => log.args.word === draw[3]);
    if (!event) {
      // Advance only after a successful finalized page. RPC failures never skip
      // a range; the final page is retried if the RPC omitted a known event.
      const next = end < block.number ? end + 1n : start;
      g.status = "waiting";
      await env.DB.prepare(
        `UPDATE operations SET fulfillment_scan_block=MAX(COALESCE(fulfillment_scan_block,0),?),
        checked_at=MAX(checked_at,?),error_code='DELIVERY_SCAN_PENDING',status='waiting',public_json=?,request_id=?,release_block=?,observed_block=? WHERE id=? AND observed_block<=?
        AND status IN ('paid','submitting','waiting','callback','refund_due')
        AND EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)`,
      )
        .bind(
          Number(next),
          Date.now(),
          JSON.stringify(g),
          draw[2].toString(),
          spentBlock,
          Number(block.number),
          op.id,
          Number(block.number),
          token,
          Date.now(),
        )
        .run();
      return true;
    }
    const finalReceipt = await client.getTransactionReceipt({
      hash: event.transactionHash,
    });
    if (
      finalReceipt.status !== "success" ||
      finalReceipt.blockHash !== event.blockHash ||
      finalReceipt.blockNumber > block.number
    )
      throw new Error("Delivery not finalized");
    status = "completed";
    g.evidence = {
      word: draw[3],
      requestId: draw[2].toString(),
      txHash: request.transactionHash,
      blockHash: request.blockHash,
      blockNumber: request.blockNumber.toString(),
      logIndex: request.logIndex,
      consumer: address,
      coordinator: COORDINATOR,
      chainId: CHAIN_ID,
      fulfillmentBlockHash: event.blockHash,
      fulfillmentBlockNumber: event.blockNumber.toString(),
      fulfillmentTxHash: event.transactionHash,
    };
  }
  g.status = status;
  await env.DB.prepare(
    "UPDATE operations SET status=?,public_json=?,request_id=?,release_block=?,checked_at=MAX(checked_at,?),error_code=NULL,observed_block=? WHERE id=? AND observed_block<=? AND status IN ('paid','submitting','waiting','callback','refund_due') AND EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)",
  )
    .bind(
      status,
      JSON.stringify(g),
      draw[2].toString(),
      spentBlock,
      Date.now(),
      Number(block.number),
      op.id,
      Number(block.number),
      token,
      Date.now(),
    )
    .run();
  return true;
}
export async function processJobs(env: Env) {
  const token = await lease(env, "relayer");
  if (!token) return;
  try {
    await reconcilePayments(env);
    const client = await chainClient(env);
    // Keep delivered requests moving even while new paid work is queued.
    const waiting = await env.DB.prepare(
      "SELECT * FROM operations WHERE status IN ('waiting','callback','refund_due') AND checked_at<? ORDER BY checked_at LIMIT 3",
    )
      .bind(Date.now() - 2500)
      .all<Operation>();
    for (const row of waiting.results) {
      try {
        await observe(env, row, client, token);
      } catch {
        await env.DB.prepare(
          "UPDATE operations SET error_code='CHAIN_CHECK_UNAVAILABLE' WHERE id=? AND status IN ('waiting','callback','refund_due') AND EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)",
        )
          .bind(row.id, token, Date.now())
          .run();
      } finally {
        await env.DB.prepare(
          "UPDATE operations SET checked_at=MAX(checked_at,?) WHERE id=? AND EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)",
        )
          .bind(Date.now(), row.id, token, Date.now())
          .run();
      }
    }
    const op = await env.DB.prepare(
      "SELECT * FROM operations WHERE status IN ('paid','submitting') ORDER BY CASE status WHEN 'submitting' THEN 0 ELSE 1 END,created LIMIT 1",
    ).first<Operation>();
    if (await processRecovery(env, client, token, op?.status === "submitting"))
      return;
    if (op) {
      if (await observe(env, op, client, token)) return;
      let raw = op.raw_tx,
        txHash = op.tx_hash;
      if (!raw) {
        const account = relayer(env),
          wallet = createWalletClient({
            chain: arc,
            account,
            transport: http(env.RPC_URL),
          }),
          g = JSON.parse(op.public_json),
          exec = g.execution;
        const nonce = await client.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });
        const request = await wallet.prepareTransactionRequest({
          account,
          chain: arc,
          to: env.CONSUMER_ADDRESS as Address,
          data: encodeFunctionData({
            abi: agentAbi,
            functionName: "startSponsored",
            args: [
              op.owner as Address,
              hash(op.id),
              op.commitment,
              BigInt(exec.value),
            ],
          }),
          value: BigInt(exec.value),
          nonce,
          gas: BigInt(exec.gas),
          maxFeePerGas: BigInt(exec.maxFeePerGas),
          maxPriorityFeePerGas: 0n,
          type: "eip1559",
        });
        raw = await wallet.signTransaction(request);
        txHash = keccak256(raw);
        const saved = await env.DB.prepare(
          "UPDATE operations SET raw_tx=?,tx_hash=?,tx_nonce=?,status='submitting' WHERE id=? AND status='paid' AND EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)",
        )
          .bind(raw, txHash, nonce, op.id, token, Date.now())
          .run();
        if (saved.meta.changes !== 1) return;
      }
      let receipt = await client
        .getTransactionReceipt({ hash: txHash! })
        .catch(() => null);
      if (!receipt) {
        try {
          await client.sendRawTransaction({ serializedTransaction: raw });
        } catch {
          /* Reconcile the exact saved transaction; never sign a replacement here. */
        }
        receipt = await client
          .getTransactionReceipt({ hash: txHash! })
          .catch(() => null);
      }
      if (receipt) {
        const finalized = await client.getBlock({ blockTag: "finalized" });
        const canonical = await client.getBlock({
          blockNumber: receipt.blockNumber,
        });
        if (
          receipt.blockNumber <= finalized.number &&
          receipt.blockHash === canonical.hash
        ) {
          if (receipt.status === "reverted")
            await env.DB.prepare(
              "UPDATE operations SET status='refund_due',error_code='DRAW_REVERTED',release_block=?,checked_at=? WHERE id=? AND status='submitting' AND tx_hash=? AND EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)",
            )
              .bind(
                Number(receipt.blockNumber),
                Date.now(),
                op.id,
                txHash,
                token,
                Date.now(),
              )
              .run();
          else await observe(env, op, client, token);
        }
      }
    }
  } catch {
    console.warn("Agent draw processing temporarily unavailable");
  } finally {
    await release(env, "relayer", token);
  }
}
export function publicOperation(env: Env, op: Operation) {
  const g = JSON.parse(op.public_json) as Giveaway;
  const disclosed = ![
    "settling",
    "payment_uncertain",
    "manual_review",
    "payment_failed",
  ].includes(op.status);
  return {
    id: op.id,
    status: op.status,
    payment: {
      amount: op.amount,
      currency: "USDC",
      network: op.payment_network,
      status: ["settling", "payment_uncertain", "manual_review"].includes(
        op.status,
      )
        ? "uncertain"
        : op.status === "payment_failed"
          ? "failed"
          : "settled",
    },
    ...(disclosed
      ? {
          giveaway: { ...g, status: op.status },
          ...(g.evidence
            ? { result: select(g.manifest, g.evidence.word, g.commitment) }
            : {}),
        }
      : {}),
    links: {
      status: `${env.PUBLIC_ORIGIN}/v1/giveaways/${op.id}`,
      proof: `${env.PUBLIC_ORIGIN}/v1/giveaways/${op.id}/proof`,
      view: `${env.WEB_ORIGIN}/agent/${op.id}`,
    },
    ...(op.error_code ? { errorCode: op.error_code } : {}),
  };
}
