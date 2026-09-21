import { it, expect, vi } from "vitest";
it("uses mainnet Gateway networks and mainnet protocol pins when compiled for production", async () => {
  vi.stubGlobal("__LOTTEWY_MAINNET__", true);
  vi.resetModules();
  try {
    const { NETWORKS, GATEWAY_URL } = await import("../src/config"),
      { CHAIN_ID, COORDINATOR } = await import("../src/protocol/shared/core"),
      { openapi } = await import("../src/openapi");
    expect(CHAIN_ID).toBe(5042);
    expect(COORDINATOR.toLowerCase()).toBe(
      "0xd20da057469c45928912d983f45790c41e290571",
    );
    expect(NETWORKS).toEqual(["eip155:5042", "eip155:8453", "eip155:1"]);
    expect(GATEWAY_URL).toBe("https://gateway-api.circle.com");
    const doc = openapi({
      PUBLIC_ORIGIN: "https://api.lottewy.com",
      SUPPORT_EMAIL: "hello@lottewy.com",
      PRICE_USDC: "0.250000",
    } as any);
    expect(doc.info.description).toContain("Arc Mainnet");
    expect(doc.servers[0].description).toContain("real USDC");
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
