import type { Hex } from "viem";
import { assert } from "./core";

export type FinalityClient = {
  getBlock(args: { blockTag: "finalized" }): Promise<{
    number: bigint | null;
    hash: Hex | null;
    timestamp: bigint;
  }>;
};

/** Arc exposes consensus finality through the finalized tag. Never substitute
 * latest or an arbitrary confirmation depth when the endpoint cannot serve it.
 */
export async function finalizedBlock(client: FinalityClient) {
  const block = await client.getBlock({ blockTag: "finalized" });
  assert(
    block &&
      typeof block.number === "bigint" &&
      block.number >= 0n &&
      typeof block.hash === "string" &&
      /^0x[\da-fA-F]{64}$/.test(block.hash) &&
      typeof block.timestamp === "bigint",
    "Finalized block is unavailable",
  );
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}
