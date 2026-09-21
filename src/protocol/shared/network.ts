import testnet from "../docs/arc-testnet.json";
import mainnet from "../docs/arc-mainnet.json";
import consumerTestnet from "../docs/lottewy-testnet.json";
import consumerMainnet from "../docs/lottewy-mainnet.json";
declare const __LOTTEWY_MAINNET__: boolean;
export const isMainnet =
  typeof __LOTTEWY_MAINNET__ !== "undefined" && __LOTTEWY_MAINNET__;
export const networkDeployment = isMainnet ? mainnet : testnet;
export const consumerDeployment = isMainnet ? consumerMainnet : consumerTestnet;
