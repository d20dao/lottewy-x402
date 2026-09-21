import { isMainnet } from "./protocol/shared/network";
export type Env = {
  PRICING_MODE?: "fixed" | "cost";
  MAX_QUOTE_USDC?: string;
  EDGE_LIMITER?: RateLimit;
  RECOVERY_MAX_USDC?: string;
  DB: D1Database;
  PUBLIC_ORIGIN: string;
  WEB_ORIGIN: string;
  SUPPORT_EMAIL: string;
  SELLER_ADDRESS: string;
  RELAYER_PRIVATE_KEY: string;
  DRAFT_SECRET: string;
  RPC_URL: string;
  CONSUMER_ADDRESS: string;
  CONSUMER_CODE_HASH: string;
  IMPLEMENTATION_ADDRESS: string;
  IMPLEMENTATION_CODE_HASH: string;
  PRICE_USDC: string;
  GAS_LIMIT: string;
  JEV_API_KEY?: string;
  JEV_MODEL: string;
  MODE: "production" | "development";
  JEV_MODE: "live";
};
export const NETWORKS = isMainnet
  ? ["eip155:5042", "eip155:8453", "eip155:1"]
  : ["eip155:5042002", "eip155:84532", "eip155:11155111"];
export const GATEWAY_URL = isMainnet
  ? "https://gateway-api.circle.com"
  : "https://gateway-api-testnet.circle.com";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const requireValue = (value: unknown, message: string) => {
  if (!value) throw new ApiError(400, "INVALID_REQUEST", message);
};
