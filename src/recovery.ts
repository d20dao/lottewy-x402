import {
  createWalletClient,
  http,
  encodeFunctionData,
  keccak256,
  parseUnits,
  type Hex,
} from "viem";
import { arc, coordinatorAbi } from "./protocol/shared/chain";
import { COORDINATOR } from "./protocol/shared/core";
import { relayer, type chainClient } from "./chain";
import { guard, type Operation } from "./store";
import type { Env } from "./config";

type Recovery = {
  operation_id: string;
  kind: "callback" | "refund";
  status: string;
  raw_tx: Hex;
  tx_hash: Hex;
};
/** One durable, bounded recovery attempt per kind. These calls never request a new random word. */
export async function processRecovery(
  env: Env,
  client: Awaited<ReturnType<typeof chainClient>>,
  token: string,
  drawPending: boolean,
) {
  let task = await env.DB.prepare(
    "SELECT * FROM recovery_transactions WHERE status='pending' ORDER BY created LIMIT 1",
  ).first<Recovery>();
  if (!task) {
    if (drawPending) return false;
    const op = await env.DB.prepare(
      `SELECT o.* FROM operations o WHERE request_id IS NOT NULL
      AND status IN ('callback','refund_due') AND NOT EXISTS(SELECT 1 FROM recovery_transactions r
        WHERE r.operation_id=o.id AND r.kind=CASE WHEN o.status='callback' THEN 'callback' ELSE 'refund' END)
      ORDER BY checked_at LIMIT 1`,
    ).first<Operation>();
    if (!op) return false;
    const block = await client.getBlock({ blockTag: "finalized" }),
      requestId = BigInt(op.request_id!);
    const request = await client.readContract({
      address: COORDINATOR,
      abi: coordinatorAbi,
      functionName: "getRequest",
      args: [requestId],
      blockNumber: block.number,
    });
    const g = JSON.parse(op.public_json),
      account = relayer(env);
    if (
      request.consumer.toLowerCase() !== env.CONSUMER_ADDRESS.toLowerCase() ||
      request.clientSeed !== op.commitment ||
      request.refundAddress.toLowerCase() !== g.refundAddress?.toLowerCase()
    )
      return false;
    const kind = op.status === "callback" ? "callback" : "refund";
    if (
      kind === "callback" &&
      (!request.fulfilled || request.delivered || request.refunded)
    )
      return false;
    if (
      kind === "refund" &&
      (request.fulfilled ||
        request.refunded ||
        request.deadline >= block.timestamp)
    )
      return false;
    const data =
      kind === "callback"
        ? encodeFunctionData({
            abi: coordinatorAbi,
            functionName: "retryCallback",
            args: [requestId, 300000],
          })
        : encodeFunctionData({
            abi: coordinatorAbi,
            functionName: "refundRequest",
            args: [requestId],
          });
    const estimated = await client.estimateGas({
        account: account.address,
        to: COORDINATOR,
        data,
      }),
      gas = (estimated * 120n + 99n) / 100n,
      maxFeePerGas = (await client.getGasPrice()) * 2n;
    const cap = parseUnits(env.RECOVERY_MAX_USDC || "0.050000", 18),
      cost = gas * maxFeePerGas;
    if (cost > cap) return false;
    const balance = await client.getBalance({
        address: account.address,
        blockNumber: block.number,
      }),
      units = Number((cost + 999999999999n) / 1000000000000n);
    const wallet = createWalletClient({
        chain: arc,
        account,
        transport: http(env.RPC_URL),
      }),
      nonce = await client.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
    const tx = await wallet.prepareTransactionRequest({
      account,
      chain: arc,
      to: COORDINATOR,
      data,
      value: 0n,
      gas,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas: 0n,
      type: "eip1559",
    });
    const raw = await wallet.signTransaction(tx),
      txHash = keccak256(raw);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO recovery_transactions(operation_id,kind,status,raw_tx,tx_hash,tx_nonce,reserved_units,created)
        SELECT ?,?,'pending',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)
        AND COALESCE((SELECT SUM(reserved_units) FROM operations WHERE release_block IS NULL OR release_block>?),0)
          +COALESCE((SELECT SUM(reserved_units) FROM recovery_transactions WHERE release_block IS NULL OR release_block>?),0)+?<=?`,
        ).bind(
          op.id,
          kind,
          raw,
          txHash,
          nonce,
          units,
          Date.now(),
          token,
          Date.now(),
          Number(block.number),
          Number(block.number),
          units,
          Number(balance / 1000000000000n),
        ),
        guard(env),
        env.DB.prepare("DELETE FROM atomic_guard"),
      ]);
      task = {
        operation_id: op.id,
        kind,
        status: "pending",
        raw_tx: raw,
        tx_hash: txHash,
      };
    } catch {
      // A refused optional reservation must not starve already-funded draws.
      // If the batch committed but its response was lost, adopt its durable raw
      // transaction before allowing another nonce. A failed lookup stays closed.
      task = await env.DB.prepare(
        "SELECT * FROM recovery_transactions WHERE status='pending' ORDER BY created LIMIT 1",
      ).first<Recovery>();
      if (!task) return false;
    }
  }
  let receipt = await client
    .getTransactionReceipt({ hash: task.tx_hash })
    .catch(() => null);
  if (!receipt) {
    await client
      .sendRawTransaction({ serializedTransaction: task.raw_tx })
      .catch(() => {});
    receipt = await client
      .getTransactionReceipt({ hash: task.tx_hash })
      .catch(() => null);
  }
  if (receipt) {
    const [finalized, canonical] = await Promise.all([
      client.getBlock({ blockTag: "finalized" }),
      client.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    if (
      receipt.blockNumber <= finalized.number &&
      canonical.hash === receipt.blockHash
    ) {
      await env.DB.prepare(
        `UPDATE recovery_transactions SET status=?,release_block=? WHERE operation_id=? AND kind=? AND status='pending'
        AND EXISTS(SELECT 1 FROM leases WHERE name='relayer' AND token=? AND expires>?)`,
      )
        .bind(
          receipt.status === "success" ? "completed" : "reverted",
          Number(receipt.blockNumber),
          task.operation_id,
          task.kind,
          token,
          Date.now(),
        )
        .run();
    }
  }
  return true;
}
