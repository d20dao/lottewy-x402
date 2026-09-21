# Lottewy Agent API

Agent-payable, verifiable giveaway draws on **Arc Mainnet**. This is a separate service from the [Lottewy website](https://lottewy.com); the website repository contains no x402 API server code.

- [OpenAPI 3.1](https://api.lottewy.com/openapi.json)
- [API guide](https://api.lottewy.com/docs)
- [Readiness](https://api.lottewy.com/health)
- [Agent instructions](https://lottewy.com/llms.txt)
- [Support](mailto:hello@lottewy.com)

## Workflow

1. `POST /v1/giveaways` with the paying EVM `owner` and a draft: title, rules, entries, winner count and optional alternates/weights. Preserve the returned `draftToken` and `privateArchive`. Preparation does not charge or persist the raw list.
2. Review the five-minute cost quote: **D20DAO fee budget + estimated gas budget**, with **zero platform markup**. Budgets allow for network variation, so actual spending may be lower.
3. `POST /v1/roll` with that exact token. An unpaid request returns `402 Payment Required`. Pay using an x402 client and a Circle Gateway-funded wallet matching `owner`. Read accepted networks, assets and amounts from the returned payment requirements.
4. A paid `200` acknowledges a durable operation, not a completed draw. Poll the returned status URL. After completion, download `/v1/giveaways/{id}/proof` and independently verify the recorded result.

The public OpenAPI amount and a bare 402 share a five-minute discovery estimate stored in D1 across all Worker instances. This estimate can change at refresh and is not a payment authorization. After preparation, POST `{ "draftToken": "..." }` to `/v1/quote/openapi` for a private, exact-price OpenAPI document. Its paid amount matches the 402 for that same token, and `x-quote-expires-at` states its expiry. Never put tokens in URLs or publish them. The encrypted draft binds the actual payment quote and execution limits. `MAX_QUOTE_USDC` rejects excessive estimates rather than charging them. If an unpaid request returns `QUOTE_CHANGED`, prepare a fresh draft. Once payment exists or is uncertain, retain the original token and status URL; never authorize another payment to resolve uncertainty.

Apply migration `0006_discovery_prices.sql` before deploying the shared discovery pricing code. It adds a small reference-price table without changing payment journals or existing operations.

## Security model

The verified payer and payment authorization are bound to one operation before settlement. Content, contract pins, relayer authorization, execution bounds and liquidity are checked before capture. Raw signed transactions and nonces are persisted before broadcast. Ambiguous submissions are reconciled rather than replaced blindly; a giveaway never rerolls to another random word.

The API uses an explicitly authorized relayer and an upgradeable consumer. Deployment addresses and code hashes are pinned in `src/protocol/docs/lottewy-mainnet.json`. Raw participant values and salts stay with the creator. Public results are masked and proof exports exclude private entries. Lottewy does not hold or deliver prizes.

D20DAO refunds return to the fixed relayer refund address. Customer refund recovery is a separate operator workflow; failed execution must not be represented as an already-completed refund.

## Development

Requires Node 24 or newer:

```sh
npm ci
npm run typecheck
npm test
node scripts/protocol-provenance.mjs
```

The local environment and deterministic fixtures are isolated from production. Protocol code is copied from a pinned commit of the website repository; do not modify it without reviewing and updating provenance. See `AGENTS.md` for contribution constraints.

## Deployment

The reviewed `env.mainnet` profile serves `api.lottewy.com`, executes on Arc (5042), and uses `PRICING_MODE=cost`. Accepted Gateway networks are advertised at runtime. Apply migrations with `wrangler d1 migrations apply DB --env mainnet --remote`, then use `npm run deploy` for an authorized release.

Upload only `RELAYER_PRIVATE_KEY`, `DRAFT_SECRET` and `JEV_API_KEY`. Use the designated relayer, never the deployer key. Keep deployment environments and draft secrets separate. Never upload a complete private environment file.

Mainnet calls move real USDC. Inspect and estimate before any approved paid test, with a cap matching the prepared quote. An unpaid 402, readiness score or CLI inspection does not prove paid execution completion. Historical validation artifacts are retained separately from current deployment evidence.

Before committing, run `node scripts/check-secrets.mjs --staged`, `node scripts/check-staged-docs.mjs` and `git diff --check`. Secrets, local databases, artifacts and private documents must stay out of Git.
