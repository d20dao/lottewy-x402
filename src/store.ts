import { ApiError, type Env } from "./config";
export type Operation = {
  id: string;
  owner: string;
  commitment: `0x${string}`;
  payment_key: string;
  status: string;
  public_json: string;
  payment_ref: string;
  amount: string;
  payment_network: string;
  settlement_json: string | null;
  reserved_units: number;
  release_block: number | null;
  tx_hash: `0x${string}` | null;
  raw_tx: `0x${string}` | null;
  tx_nonce: number | null;
  request_id: string | null;
  error_code: string | null;
  created: number;
  proof_ref: string | null;
};
export async function operation(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM operations WHERE id=?")
    .bind(id)
    .first<Operation>();
}
export async function quota(
  env: Env,
  key: string,
  seconds: number,
  limit: number,
) {
  const now = Math.floor(Date.now() / 1000),
    bucket = `${key}:${Math.floor(now / seconds)}`;
  const row = await env.DB.prepare(
    "INSERT INTO quotas(bucket,count,expires) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(bucket, now + seconds)
    .first<{ count: number }>();
  if (!row || row.count > limit)
    throw new ApiError(
      429,
      "RATE_LIMIT",
      "Too many requests. Retry later; no payment was captured for this attempt.",
    );
}
export async function lease(env: Env, name: string, ms = 60000) {
  const token = crypto.randomUUID(),
    now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE leases SET token=?,expires=? WHERE name=? AND expires<?",
  )
    .bind(token, now + ms, name, now)
    .run();
  return result.meta.changes === 1 ? token : null;
}
export async function release(env: Env, name: string, token: string) {
  await env.DB.prepare(
    "UPDATE leases SET token=NULL,expires=0 WHERE name=? AND token=?",
  )
    .bind(name, token)
    .run();
}
export const guard = (env: Env) =>
  env.DB.prepare(
    "INSERT INTO atomic_guard(ok) VALUES(CASE WHEN changes()=1 THEN 1 ELSE 0 END)",
  );
