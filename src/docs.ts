import type { Env } from "./config";
export function apiDocs(env: Env) {
  const example = JSON.stringify(
    {
      owner: "0xYOUR_PAYMENT_WALLET_ADDRESS",
      draft: {
        title: "Community giveaway",
        description: "A community thank-you draw.",
        rules: "Free entry. Equal chances. The organizer delivers the prize.",
        entries: ["alice", "bob", "carol"],
        winners: 1,
        reserves: 1,
      },
    },
    null,
    2,
  );
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lottewy Agent API</title><meta name="description" content="Create a giveaway draft, pay its D20DAO plus gas quote with your agent wallet, and verify the recorded result."><link rel="icon" href="/favicon.svg" type="image/svg+xml"><meta property="og:title" content="Lottewy Agent API"><meta property="og:description" content="Verifiable giveaway draws, paid through Circle Gateway x402."><meta property="og:image" content="${env.WEB_ORIGIN}/brand/lottewy-og.png"><style>body{max-width:800px;margin:40px auto;padding:0 22px;font:16px/1.75 system-ui;color:#20251c;background:#fafaf7}h1,h2{line-height:1.25}header{display:flex;gap:16px;align-items:center}pre{padding:20px;background:#eef2e8;border-radius:10px;overflow:auto;font-size:13px}code{overflow-wrap:anywhere}a{color:#466a27}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #dde3d5;padding:12px 8px;vertical-align:top}.note{color:#627056}</style></head><body><header><img src="/logo.svg" width="48" height="48" alt="Lottewy"><h1>Lottewy Agent API</h1></header><p>Create a giveaway with your agent wallet, pay for one draw, then read and verify its result on Arc Mainnet.</p><p><a href="/openapi.json">OpenAPI 3.1</a> · <a href="${env.WEB_ORIGIN}/llms.txt">Agent guide</a> · <a href="https://github.com/d20dao/lottewy-x402/blob/master/examples/giveaway-agent.mjs">Working SDK example</a> · <a href="mailto:${env.SUPPORT_EMAIL}">Support</a></p>
 <h2>1. Prepare the giveaway object</h2><p>Use the public address of the wallet that will pay. No website login, API key or SIWE session is required. Your private key stays with your wallet; never send it to Lottewy.</p><p><code>POST ${env.PUBLIC_ORIGIN}/v1/giveaways</code></p><pre>${example}</pre><p>Replace the owner placeholder with your paying EVM address. Save <code>id</code>, <code>draftToken</code>, <code>privateArchive</code>, <code>price</code> and <code>expiresAt</code>. This step is free. The draft is client-held and is not yet a stored public giveaway.</p>
 <h2>2. Review the quote and roll</h2><p>The five-minute quote is the D20DAO fee budget plus estimated gas budget. Platform markup is zero. Actual network spending can be lower than these conservative budgets.</p><p><code>POST ${env.PUBLIC_ORIGIN}/v1/roll</code></p><pre>{ "draftToken": "THE_EXACT_TOKEN_FROM_PREPARATION" }</pre><p>An unpaid call returns <code>402</code> and <code>PAYMENT-REQUIRED</code>. An x402 client signs the selected USDC authorization with your Gateway-funded wallet and retries with <code>PAYMENT-SIGNATURE</code>. The verified payer must match <code>owner</code>. Read the exact amount, network, asset and recipient from that response before approving payment. Mainnet payments use real funds.</p><p>With an already configured Circle Gateway client:</p><pre>const { data: operation } = await gateway.pay(
  "${env.PUBLIC_ORIGIN}/v1/roll",
  { method: "POST", body: { draftToken: prepared.draftToken } }
);</pre><p>Set a payment-creation hook to cap authorization at the prepared quote; the linked SDK example includes this guard. A paid <code>200</code> means the operation is durably queued, not that winners are already available.</p>
 <h2>3. Read status and results</h2><table><thead><tr><th>Method</th><th>Purpose</th></tr></thead><tbody><tr><td><code>GET /v1/giveaways/{id}</code></td><td>Status, payment state, and the recorded giveaway/result when available.</td></tr><tr><td><code>GET /v1/giveaways/{id}/proof</code></td><td>Verified public proof JSON after completion.</td></tr></tbody></table><p>Use the returned <code>links.status</code>, <code>links.proof</code> and <code>links.view</code>. Poll status until completed, then share the public result page.</p>
 <h2>Wallet history and listing</h2><p>There is currently no wallet-wide or global giveaway listing endpoint. Keep a local index of your saved giveaway IDs and status URLs. A known result can be read by ID without a wallet signature. Website Explorer listing is separate from API operations; API draws are not automatically added to the website Explorer.</p>
 <h2>Safe retries</h2><p>Keep the original draftToken after lost responses. Existing operations return without another settlement. Never create another draft or payment for <code>payment_uncertain</code>, <code>manual_review</code> or <code>refund_due</code>. Poll the original ID. Only an unpaid <code>QUOTE_CHANGED</code> or expired quote should start a fresh preparation.</p><p class="note">Public manifests mask non-wallet entries. Raw participants and salts remain in your privateArchive. Lottewy selects winners; the organizer delivers prizes. Cryptographic proof does not establish participant identity or guarantee prize delivery.</p></body></html>`;
}
