# Contribution instructions

This repository contains the Lottewy agent API only. Keep payment server code separate from the website repository. Product copy and committed documentation are English.

## Preserve the trust boundaries

- Keep the official Circle Gateway middleware as the payment verifier/settler. Fetch current official SDK/API documentation when changing integration behavior.
- Bind the verified payer, actual authorization identity and draft commitment to a single durable operation before settlement.
- A prepared cost quote is D20DAO fee budget plus estimated gas, with no platform markup. The encrypted token fixes its price, expiry and execution bounds. Never increase the charge after payment.
- A paid response acknowledges an operation, not a completed draw. Retry the original operation/token; never reroll or create another authorization to recover uncertainty.
- Persist raw signed transactions and nonces before broadcast. Do not clear ambiguous reservations or payment journals. Fence updates with current leases and preserve retry backoff under concurrent workers.
- Keep raw participant values, salts, draft tokens and payment authorizations private. Public proofs expose only the documented public data.
- Recheck chain ID, consumer/coordinator pins, relayer authorization, gas limits and available funds before payment capture.

## Network and source consistency

The live service executes on Arc Mainnet (5042). The compiled `__LOTTEWY_MAINNET__` flag selects protocol and Gateway profiles together. Local fixtures use an isolated profile; never point them at production balances or databases.

`src/protocol/` is vendored from a pinned website-repository commit. Make protocol changes upstream, review the copy, and run `node scripts/protocol-provenance.mjs --write` only when every copied file matches that commit. Do not patch vendored files independently.

## Credentials and release

Never print or commit `.env`, `.env.mainnet`, `.dev.vars`, private keys, tokens, databases or recovery bundles. The API Worker needs only the relayer key, draft-encryption secret and JEV key. It must never receive the deployer key. Keep private/Turkish Markdown out of commits.

Deployments, paid mainnet tests and onchain transactions require user authorization. Existing explicit authorization remains valid; do not ask repeatedly. A routine API redeploy must not deploy a new contract or change the relayer identity.

## Validation

Run the checks appropriate to the change:

```sh
npm run typecheck
npm test
node scripts/protocol-provenance.mjs
node scripts/check-secrets.mjs --staged
node scripts/check-staged-docs.mjs
git diff --check
```

Use meaningful tests for payment binding, quote drift, idempotency, lease races and recovery. Do not mistake mocked tests, HTTP 402 inspection or a readiness score for a real paid end-to-end draw. Report exactly which live checks ran.
