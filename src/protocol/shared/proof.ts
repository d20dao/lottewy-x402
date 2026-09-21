import {
  createPublicClient,
  http,
  parseAbi,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  parseEventLogs,
  type Address,
  type Log,
  type TransactionReceipt,
} from "viem";
import {
  builtins,
  decodeEvidencePacket,
  deriveRequestSeed,
  hashProof,
  hashPublicKey,
  verifyVRFProof,
  type XY,
} from "@d20dao/vrf-sdk";
import { arc, consumerAbi, coordinatorAbi } from "./chain";
import { assert, CHAIN_ID, COORDINATOR, hash, type Giveaway } from "./core";
import { finalizedBlock } from "./finality";
import {
  networkDeployment as deployment,
  consumerDeployment as lottewyDeployment,
} from "./network";
const evidenceAbi = parseAbi([
  "event FulfillmentEvidence(uint256 indexed requestId, bytes32 indexed transcriptHash, bytes packet)",
]);
function receiptLogs(receipt: TransactionReceipt, address: Address) {
  return receipt.logs.filter(
    (log: Log) =>
      !log.removed &&
      log.address.toLowerCase() === address.toLowerCase() &&
      log.transactionHash === receipt.transactionHash &&
      log.blockHash === receipt.blockHash &&
      log.blockNumber === receipt.blockNumber,
  );
}
/** Independent RPC reads plus pinned deployment/key; never trusts DB word alone.
 * Epoch source attestations remain under the coordinator/registry onchain trust model.
 */
export async function verifyD20(g: Giveaway, rpcUrl?: string) {
  const evidence = g.evidence;
  assert(
    evidence &&
      evidence.chainId === CHAIN_ID &&
      evidence.coordinator.toLowerCase() === COORDINATOR.toLowerCase(),
    "Evidence network or coordinator mismatch",
  );
  const rpc = createPublicClient({ chain: arc, transport: http(rpcUrl) });
  assert((await rpc.getChainId()) === CHAIN_ID, "Incorrect RPC network");
  const finalized = await finalizedBlock(rpc);
  const requestId = BigInt(evidence.requestId),
    consumer = evidence.consumer as Address,
    key = keccak256(
      encodeAbiParameters(parseAbiParameters("address,bytes32"), [
        g.owner as Address,
        hash(g.id),
      ]),
    );
  const consumerCode = await rpc.getCode({ address: consumer });
  assert(
    consumer.toLowerCase() === lottewyDeployment.address.toLowerCase() &&
      consumerCode &&
      keccak256(consumerCode) === lottewyDeployment.codeHash,
    "Unrecognized Lottewy consumer deployment",
  );
  const slot =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const consumerDeployment = lottewyDeployment as typeof lottewyDeployment & {
    implementationAddress?: string;
    implementationCodeHash?: string;
  };
  if (consumerDeployment.implementationAddress) {
    const [implementationSlot, code] = await Promise.all([
      rpc.getStorageAt({ address: consumer, slot }),
      rpc.getCode({
        address: consumerDeployment.implementationAddress as Address,
      }),
    ]);
    assert(
      implementationSlot?.slice(-40).toLowerCase() ===
        consumerDeployment.implementationAddress.slice(2).toLowerCase() &&
        code &&
        keccak256(code) === consumerDeployment.implementationCodeHash,
      "Lottewy implementation changed",
    );
  }
  for (const [proxy, implementation, expected] of [
    [
      deployment.coordinator,
      deployment.coordinatorImplementation,
      deployment.coordinatorImplementationCodeHash,
    ],
    [
      deployment.registry,
      deployment.epochImplementation,
      deployment.epochImplementationCodeHash,
    ],
  ]) {
    const [current, code] = await Promise.all([
      rpc.getStorageAt({ address: proxy as Address, slot }),
      rpc.getCode({ address: implementation as Address }),
    ]);
    assert(
      current?.slice(-40).toLowerCase() ===
        implementation.slice(2).toLowerCase() &&
        code &&
        keccak256(code) === expected,
      "Deployment implementation changed; review is required",
    );
  }
  const [request, draw, receipt, coordinator] = await Promise.all([
    rpc.readContract({
      address: COORDINATOR,
      abi: coordinatorAbi,
      functionName: "getRequest",
      args: [requestId],
      blockNumber: finalized.number,
    }),
    rpc.readContract({
      address: consumer,
      abi: consumerAbi,
      functionName: "draws",
      args: [key],
      blockNumber: finalized.number,
    }),
    rpc.getTransactionReceipt({ hash: evidence.txHash }),
    rpc.readContract({
      address: consumer,
      abi: consumerAbi,
      functionName: "coordinator",
      blockNumber: finalized.number,
    }),
  ]);
  assert(
    coordinator.toLowerCase() === COORDINATOR.toLowerCase() &&
      receipt.status === "success" &&
      receipt.transactionHash === evidence.txHash &&
      receipt.blockHash === evidence.blockHash &&
      receipt.blockNumber === BigInt(evidence.blockNumber) &&
      receipt.blockNumber === request.requestBlock,
    "Receipt or consumer mismatch",
  );
  const requested = parseEventLogs({
    abi: consumerAbi,
    eventName: "DrawRequested",
    logs: receiptLogs(receipt, consumer),
    strict: true,
  }).find(
    ({ args }) =>
      args.key === key &&
      args.owner.toLowerCase() === g.owner.toLowerCase() &&
      args.giveawayId === hash(g.id) &&
      args.commitment === g.commitment &&
      args.requestId === requestId,
  );
  assert(requested, "Request receipt does not contain the matching draw");
  assert(
    draw[0].toLowerCase() === g.owner &&
      draw[1] === g.commitment &&
      draw[2] === requestId &&
      draw[3] === evidence.word &&
      draw[4] === 2,
    "Consumer does not bind to this selection",
  );
  assert(
    request.consumer.toLowerCase() === consumer.toLowerCase() &&
      request.refundAddress.toLowerCase() ===
        (g.refundAddress || g.owner).toLowerCase() &&
      request.clientSeed === g.commitment &&
      request.fulfilled &&
      request.delivered &&
      request.randomness === evidence.word,
    "Coordinator inputs do not match",
  );
  const to =
    request.requestBlock + 2000n < finalized.number
      ? request.requestBlock + 2000n
      : finalized.number;
  const blockAt = (blockNumber: bigint) =>
    blockNumber === finalized.number
      ? Promise.resolve(finalized)
      : rpc.getBlock({ blockNumber });
  const requestBlock = await blockAt(receipt.blockNumber);
  assert(
    requestBlock.hash === receipt.blockHash &&
      receipt.blockNumber <= finalized.number,
    "Request block or finality context mismatch",
  );
  const logs = await rpc.getContractEvents({
    address: COORDINATOR,
    abi: evidenceAbi,
    eventName: "FulfillmentEvidence",
    args: { requestId },
    fromBlock: request.requestBlock,
    toBlock: to,
  });
  const event = logs.find(
    (e) =>
      !e.removed &&
      e.address.toLowerCase() === COORDINATOR.toLowerCase() &&
      e.args.requestId === requestId &&
      e.args.transcriptHash === request.transcriptHash,
  );
  assert(event?.args.packet, "VRF proof packet not found");
  const [acceptance, target, acceptedReceipt] = await Promise.all([
    blockAt(event.blockNumber),
    blockAt(request.targetBlock),
    rpc.getTransactionReceipt({ hash: event.transactionHash }),
  ]);
  assert(
    event.blockNumber <= finalized.number &&
      acceptedReceipt.status === "success" &&
      acceptedReceipt.transactionHash === event.transactionHash &&
      acceptedReceipt.blockHash === event.blockHash &&
      acceptedReceipt.blockNumber === event.blockNumber &&
      acceptance.hash === event.blockHash &&
      acceptance.timestamp <= request.deadline &&
      target.hash === request.blockHash,
    "Block or finality context mismatch",
  );
  assert(
    parseEventLogs({
      abi: evidenceAbi,
      eventName: "FulfillmentEvidence",
      logs: receiptLogs(acceptedReceipt, COORDINATOR),
      strict: true,
    }).some(
      (log) =>
        log.logIndex === event.logIndex &&
        log.args.requestId === requestId &&
        log.args.transcriptHash === request.transcriptHash &&
        log.args.packet === event.args.packet,
    ),
    "Proof packet is not included in the acceptance receipt",
  );
  // Delivery can be a later retry, so its receipt is independent of proof acceptance.
  const acceptedDelivery = parseEventLogs({
    abi: consumerAbi,
    eventName: "DrawFulfilled",
    logs: receiptLogs(acceptedReceipt, consumer),
    strict: true,
  }).some(
    ({ args }) =>
      args.key === key &&
      args.requestId === requestId &&
      args.word === evidence.word,
  );
  const fulfillmentTx =
    evidence.fulfillmentTxHash ||
    (acceptedDelivery ? event.transactionHash : undefined) ||
    (
      await rpc.getContractEvents({
        address: consumer,
        abi: consumerAbi,
        eventName: "DrawFulfilled",
        args: { key, requestId },
        fromBlock: request.requestBlock,
        toBlock: finalized.number,
      })
    ).find((log) => log.args.word === evidence.word)?.transactionHash;
  assert(fulfillmentTx, "Fulfillment transaction not found");
  const deliveredReceipt =
    fulfillmentTx === event.transactionHash
      ? acceptedReceipt
      : await rpc.getTransactionReceipt({ hash: fulfillmentTx });
  const deliveredBlock =
    deliveredReceipt.blockNumber === event.blockNumber
      ? acceptance
      : await blockAt(deliveredReceipt.blockNumber);
  assert(
    deliveredReceipt.status === "success" &&
      deliveredReceipt.transactionHash === fulfillmentTx &&
      deliveredReceipt.blockNumber >= event.blockNumber &&
      deliveredBlock.hash === deliveredReceipt.blockHash &&
      deliveredReceipt.blockNumber <= finalized.number &&
      (evidence.fulfillmentBlockHash === undefined ||
        evidence.fulfillmentBlockHash === deliveredReceipt.blockHash) &&
      (evidence.fulfillmentBlockNumber === undefined ||
        BigInt(evidence.fulfillmentBlockNumber) ===
          deliveredReceipt.blockNumber),
    "Fulfillment receipt or finality context mismatch",
  );
  assert(
    parseEventLogs({
      abi: consumerAbi,
      eventName: "DrawFulfilled",
      logs: receiptLogs(deliveredReceipt, consumer),
      strict: true,
    }).some(
      ({ args }) =>
        args.key === key &&
        args.requestId === requestId &&
        args.word === evidence.word,
    ),
    "Fulfillment receipt does not contain the matching draw",
  );
  const pk = deployment.publicKey.map(BigInt) as unknown as XY,
    proof = decodeEvidencePacket(event.args.packet).proof;
  const seed = deriveRequestSeed({
    chainId: BigInt(CHAIN_ID),
    coordinator: COORDINATOR,
    keyHash: hashPublicKey(pk),
    requestId,
    consumer,
    clientSeed: g.commitment,
    mapping: builtins.raw(),
    requestBlock: request.requestBlock,
    targetBlock: request.targetBlock,
    blockHash: request.blockHash,
    epochId: request.epochId,
    epochHash: request.epochHash,
  });
  const verified = verifyVRFProof(proof, pk, seed);
  assert(
    verified.valid &&
      verified.randomness === evidence.word &&
      hashProof(proof) === request.proofHash,
    "VRF proof could not be verified",
  );
  return {
    valid: true,
    requestId: requestId.toString(),
    word: evidence.word,
    proofHash: request.proofHash,
    transcriptHash: request.transcriptHash,
    packet: event.args.packet,
    acceptanceTx: event.transactionHash,
    request,
    publicKey: deployment.publicKey,
    scope:
      "VRF proof + pinned key + request/consumer/receipt/block bindings; epoch source attestations rely on onchain coordinator verification",
  };
}
