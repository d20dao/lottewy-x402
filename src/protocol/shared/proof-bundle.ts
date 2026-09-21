import {
  assert,
  hash,
  traceSelection,
  type Giveaway,
  type Manifest,
} from "./core";
import type { Hex } from "viem";
import type { verifyD20 } from "./proof";
type VerifiedProof = Awaited<ReturnType<typeof verifyD20>>;
export function proofBundle(
  g: Giveaway,
  word: Hex,
  proof?: VerifiedProof,
  demo = false,
) {
  assert(g.status === "completed", "Only completed results can be exported");
  const m = g.manifest;
  // Explicit public allowlist: never serialize an owner-only API response or salts.
  const manifest: Manifest = {
    version: m.version,
    algorithm: m.algorithm,
    normalization: m.normalization,
    masking: m.masking,
    id: m.id,
    owner: m.owner,
    revision: m.revision,
    title: m.title,
    description: m.description,
    rules: m.rules,
    winners: m.winners,
    reserves: m.reserves,
    entries: m.entries.map((e) => ({
      id: e.id,
      label: e.label,
      commitment: e.commitment,
      ...(e.weight === undefined ? {} : { weight: e.weight }),
    })),
  };
  assert(
    hash(manifest) === g.commitment,
    "The public manifest does not match its commitment",
  );
  assert(
    demo ||
      (g.evidence?.word === word &&
        proof?.valid &&
        proof.word === word &&
        proof.requestId === g.evidence.requestId),
    "Onchain verification is required before exporting this proof",
  );
  const trace = traceSelection(manifest, word, g.commitment);
  const entry = (id: number, index: number) => ({
    rank: index + 1,
    ...manifest.entries[id - 1],
  });
  const e = g.evidence;
  return {
    schema: "lottewy-proof-bundle-v1",
    kind: demo ? "demo" : "onchain",
    giveaway: { id: g.id, owner: g.owner, revision: g.revision },
    commitment: g.commitment,
    manifest,
    randomWord: word,
    results: {
      winners: trace.outcome.winners.map(entry),
      alternates: trace.outcome.reserves.map(entry),
    },
    selection: {
      algorithm: manifest.algorithm,
      domain: trace.domain,
      steps: trace.steps,
    },
    onchain: demo
      ? null
      : {
          chainId: e!.chainId,
          coordinator: e!.coordinator,
          consumer: e!.consumer,
          refundAddress: g.refundAddress || g.owner,
          requestId: e!.requestId,
          requestTransaction: e!.txHash,
          requestBlock: {
            number: e!.blockNumber,
            hash: e!.blockHash,
            logIndex: e!.logIndex,
          },
          fulfillmentTransaction: e!.fulfillmentTxHash,
          fulfillmentBlock: {
            number: e!.fulfillmentBlockNumber,
            hash: e!.fulfillmentBlockHash,
          },
          vrf: {
            packet: proof!.packet,
            proofHash: proof!.proofHash,
            transcriptHash: proof!.transcriptHash,
            acceptanceTransaction: proof!.acceptanceTx,
            publicKey: proof!.publicKey,
            request: proof!.request,
          },
          checksPerformedAtExport: proof!.scope,
        },
    verification: {
      manifestHash:
        "Keccak-256 of the Lottewy canonical typed serialization, not JSON.stringify(manifest).",
      replay:
        "Replay the versioned selection algorithm using manifest, randomWord and commitment. Compare all winner and alternate entry IDs in order; selection.steps records each derived hash and range operation.",
      onchain: demo
        ? "Synthetic demo: no onchain randomness proof."
        : "Independently verify canonical transaction receipts, request/consumer/seed bindings and the D20DAO VRF packet against the public key. Do not treat this JSON or its export checks as a trusted signature.",
      scope:
        "Public entry commitments and masked labels only. Raw private entries and their salts are excluded. Epoch source attestations rely on coordinator and registry onchain verification. This does not prove participant identity or prize delivery.",
    },
  };
}
export const serializeProofBundle = (bundle: ReturnType<typeof proofBundle>) =>
  JSON.stringify(
    bundle,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
