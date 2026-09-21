import type { Address, Hex } from "viem";
import { CHAIN_ID, hash } from "./core";
export function drawIntent(
  consumer: Address,
  owner: Address,
  executor: Address,
  id: string,
  commitment: Hex,
  maxFee: bigint,
  deadline: bigint,
) {
  return {
    domain: {
      name: "Lottewy Draw",
      version: "2",
      chainId: CHAIN_ID,
      verifyingContract: consumer,
    },
    primaryType: "DrawIntent" as const,
    types: {
      DrawIntent: [
        { name: "owner", type: "address" },
        { name: "executor", type: "address" },
        { name: "giveawayId", type: "bytes32" },
        { name: "commitment", type: "bytes32" },
        { name: "maxFee", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    message: {
      owner,
      executor,
      giveawayId: hash(id),
      commitment,
      maxFee,
      deadline,
    },
  };
}
