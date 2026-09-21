# Lottewy Agent API

Separate x402 service for preparing giveaway drafts, paying for one draw and retrieving public verifiable results. The website repository contains no x402 server code. The mainnet profile executes on Arc (5042), with USDC payments through Circle Gateway. Inspect the live 402 for accepted payment networks.

## Workflow

1. `POST /v1/giveaways` with the paying EVM `owner` and a draft containing title, rules, participant entries and winner count. Keep the returned encrypted `draftToken` and `privateArchive` privately. Preparation does not store the raw participant list.
2. `POST /v1/roll` with `draftToken`. The official Circle Gateway middleware returns an x402 v2 HTTP 402 challenge. The payment wallet must match the draft owner.
3. Pay the prepared quote in USDC. Cost pricing uses the D20DAO fee budget plus estimated gas budget, with zero platform markup. Quotes expire after five minutes and are bound to the encrypted draft token. A successful response acknowledges a durable operation, not a completed draw. Poll the status URL until completed.
4. Download `/v1/giveaways/{id}/proof` for the masked manifest, commitment, winner order and verified VRF evidence. Raw values and salts remain in the creator's private archive.

Always retry the same draft token after a lost response. An existing operation is returned without another settlement, even without another payment header. Never authorize a fresh payment for an uncertain operation.

An unpaid `QUOTE_CHANGED` response means network costs exceed the quote and no payment was captured; prepare a fresh draft. Bare 402 and OpenAPI amounts are reference estimates. The exact payment terms come from the prepared token. Service and gas budgets allow for network variation, so actual spending may be lower. `MAX_QUOTE_USDC` rejects estimates above the operator ceiling rather than charging them.

## Security and trust

The signed payment identity is bound to exactly one operation before settlement. The service checks content, estimated execution gas and funding before capture. Signed raw transactions are persisted before broadcast; uncertain submissions rebroadcast those exact bytes. A background pass reconciles uncertain payments with Gateway's transfer lookup and validates payer, recipient, amount, network, token and nonce. An empty or malformed lookup cannot trigger a second capture. Documented payer refusals do not trip the global breaker. Uncertainty persisting for an hour enters `manual_review`; its reservation remains held and slower lookup continues. Multiple unresolved operations or a stuck sender pause new sales.

Callback failure and request expiry each get one bounded, journaled recovery transaction. The callback retry uses the same accepted word; expiry recovery requests the D20 fee refund and never starts another draw. Recovery expenses have a separate 0.05 test-USDC cap and cannot consume money reserved for other operations. If that attempt fails, an operator must investigate. API customer refunds are not automatic and must be reconciled separately from the D20 coordinator fee refund.

The consumer is upgradeable and the API relayer is explicitly authorized. The relayer authenticates the payment payer offchain; onchain proof verifies the fixed selection, not the payment, participant identities or prize delivery. Coordinator expiry refunds for sponsored requests go to the service relayer that paid native USDC on Arc. This avoids routing them to an unusable cross-chain smart-wallet address. API-level refunds to customers remain a separate operator workflow; unresolved operations must not be silently retried as new draws.

## Development

Requires Node 24 or newer. Install with `npm ci`, then `npm run typecheck` and `npm test`. Copy `.env.example` to a private `.dev.vars` for Wrangler; configure a dedicated testnet relayer, a random 32-byte draft encryption key and JEV. Never use the deployer key as the Worker relayer. Apply local D1 migrations before `npm run dev`.

`GET /openapi.json` publishes OpenAPI 3.1 with request schemas, field descriptions, payment metadata and agent guidance. The reviewed `env.mainnet` targets `api.lottewy.com`, uses `hello@lottewy.com` for support and `PRICING_MODE=cost`. Apply remote migrations for that environment before `npm run deploy`. Upload only the relayer key, mainnet draft-encryption secret and JEV key; never upload the deployer key. Testnet and mainnet databases and draft secrets are isolated.

## Release checks

Run unit/integration tests, contract tests in the website repository, a live testnet draw, proof replay, real HTTP 402 inspection and a capped testnet paid call before release. Circle CLI inspection alone is not proof of payment completion. Never use a logged-in mainnet wallet for these tests. `node scripts/protocol-provenance.mjs` verifies copied protocol source against its recorded hashes.

The local Worker passed a real Circle Gateway SDK payment of 0.25 test USDC and completed D20DAO request **5263**, including independent proof export. Public evidence is in `docs/testnet-paid-e2e.json` and `docs/testnet-paid-proof.json`; private draft tokens and salts are excluded. The local test price is not an approved public launch price. Circle CLI inspection detected the 402 challenge and all three advertised test networks; a paid CLI test still requires a testnet agent-wallet session. The hosted API and marketplace score check remain pending publication configuration.

The read-only D20DAO agent API reference reviewed for payment identity, durable transaction journaling and uncertainty recovery was `d20dao/agent-api` at commit `9f7a399c697647346eb85844db85678bfd310906`. Its automatic replacement-draw behavior is deliberately not part of Lottewy: a giveaway never rerolls to a new random word.

The follow-up Astra high review found and verified fixes for finalized binding-conflict queue starvation, historical fulfillment log gaps, unsent conflict reservations and unaffordable optional recovery. Conflicts are isolated as `binding_conflict`; pending signed nonces are preserved until their canonical receipts. Historical scans persist bounded consecutive pages in the waiting queue. Optional recovery yields to already-funded draws, and an uncertain journal acknowledgement is reconciled before another nonce can be used.

The final pre-mainnet run completed request **5264** with one new 0.25 test-USDC SDK payment and verified proof export. This is historical testnet evidence, not a mainnet paid-call test. The mainnet consumer is separately deployed and pinned in `src/protocol/docs/lottewy-mainnet.json`. Mainnet uses real funds; inspect and estimate before any approved paid test. Unit tests cover cost-quote binding, no-markup pricing, cost drift and mainnet network selection.

Secrets, local databases, artifacts and private Markdown are ignored. Before committing, run `node scripts/check-secrets.mjs --staged` and `node scripts/check-staged-docs.mjs`. Only English README and implementation documentation are intended for publication.
