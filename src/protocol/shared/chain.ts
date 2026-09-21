import { defineChain, parseAbi } from "viem";
import { CHAIN_ID } from "./core";
import { isMainnet } from "./network";
export const arc = defineChain({
  id: CHAIN_ID,
  name: isMainnet ? "Arc" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        isMainnet
          ? "https://rpc.blockdaemon.mainnet.arc.io"
          : "https://rpc.testnet.arc.io",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: isMainnet ? "Arc Explorer" : "Arcscan",
      url: isMainnet
        ? "https://explorer.arc.io"
        : "https://testnet.arcscan.app",
    },
  },
  testnet: !isMainnet,
});
export const consumerAbi = parseAbi([
  "function start(bytes32 giveawayId, bytes32 commitment) payable returns (uint256)",
  "function draws(bytes32 key) view returns (address owner, bytes32 commitment, uint256 requestId, bytes32 word, uint8 status)",
  "function coordinator() view returns (address)",
  "function overpaymentCredits(address) view returns (uint256)",
  "function withdrawOverpayment(address recipient)",
  "event DrawRequested(bytes32 indexed key, address indexed owner, bytes32 indexed giveawayId, bytes32 commitment, uint256 requestId)",
  "event DrawFulfilled(bytes32 indexed key, uint256 indexed requestId, bytes32 word)",
]);
export const coordinatorAbi = parseAbi([
  "function quoteFeeAt(uint32 callbackGasLimit, uint256 baseFee) view returns (uint256)",
  "function retryCallback(uint256 requestId, uint32 gasLimit)",
  "function refundRequest(uint256 requestId)",
  "function refundCredits(address) view returns (uint256)",
  "function withdrawRefundCredit(address recipient)",
  "function retryRefundCallback(uint256 requestId, uint32 gasLimit)",
  "function requestFeePaid(uint256 requestId) view returns (uint256)",
  "function requestRefundBps(uint256 requestId) view returns (uint16)",
  "function getRequest(uint256 requestId) view returns ((address consumer, uint32 callbackGasLimit, uint64 requestBlock, uint64 targetBlock, uint64 deadline, address refundAddress, bytes32 clientSeed, bytes32 mappingHash, bytes32 blockHash, bytes32 randomness, bytes32 proofHash, bytes32 transcriptHash, bool fulfilled, bool delivered, bool refunded, uint64 epochId, bytes32 epochHash) result)",
]);
