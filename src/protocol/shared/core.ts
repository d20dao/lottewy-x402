import {
  getAddress,
  isAddress,
  keccak256,
  toHex,
  concatHex,
  type Hex,
} from "viem";
export const ALGORITHM = "lottewy-fy-reject-v1";
export const WEIGHTED_ALGORITHM = "lottewy-weighted-reject-v2";
export const MAX_WEIGHT = 1000;
// Match browser maxlength semantics and preserve existing payload limits.
export const TITLE_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 4000;
export const RULES_MAX_LENGTH = 4000;
export function weightingConflict(
  rules: string,
  weights?: number[],
): string | null {
  if (!weights?.length || weights.every((w) => w === weights[0])) return null;
  const sentences = rules.toLowerCase().split(/[.!?\n]/);
  if (
    sentences.some(
      (s) =>
        !/(?:not|unequal|different)\b/.test(s) &&
        /(?:each|every|all|entries|participants).{0,100}(?:equal|same) chance/.test(
          s,
        ),
    )
  )
    return "The rules promise equal chances, but the entries have different weights. Describe weighted selection in the rules, or use equal weights.";
  return null;
}
export const CHAIN_ID = 5042002;
export const COORDINATOR =
  "0xd20DA0FF9087d053f0291524Eac12abA1ADBd945" as const;
export type Draft = {
  /** Explorer discoverability; signed metadata, not part of the draw manifest. */
  listed?: boolean;
  weights?: number[];
  title: string;
  description: string;
  rules: string;
  entries: string[];
  winners: number;
  reserves: number;
};
export type Entry = {
  id: number;
  label: string;
  commitment: Hex;
  weight?: number;
};
export type Manifest = {
  version: 1;
  algorithm: string;
  normalization: "nfc-trim-v1";
  masking: "strict-v1" | "strict-v2-en";
  id: string;
  owner: string;
  revision: number;
  title: string;
  description: string;
  rules: string;
  winners: number;
  reserves: number;
  entries: Entry[];
};
export type Giveaway = {
  refundAddress?: `0x${string}`;
  listed?: boolean;
  history?: { revision: number; commitment: Hex }[];
  attempts?: { outcome: string; tx_hash: Hex; observed: number }[];
  reservation?: { nonce: number | null; consumer: string };
  id: string;
  slug: string;
  owner: string;
  revision: number;
  status: string;
  manifest: Manifest;
  commitment: Hex;
  created: number;
  review: { mode: string; model: string; policy: string };
  recovery?: {
    requestId: string;
    consumer: string;
    deadline: string;
    callbackFailed: boolean;
    refundable: boolean;
    refunded: boolean;
    refundCredit: string;
    overpaymentCredit: string;
    feePaid: string;
    refundBps: number;
  };
  evidence?: {
    word: Hex;
    requestId: string;
    txHash: Hex;
    blockHash: Hex;
    blockNumber: string;
    logIndex?: number;
    consumer: string;
    coordinator: string;
    chainId: number;
    fulfillmentBlockHash?: Hex;
    fulfillmentBlockNumber?: string;
    fulfillmentTxHash?: Hex;
  };
  hidden?: boolean;
};
export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
// Canonical, typed, length-prefixed UTF-8. Keys sorted by UTF-16 code units;
// integers decimal, no floating point or undefined. No JSON key-order dependence.
export function canonical(value: unknown): string {
  if (value === null) return "n";
  if (typeof value === "string")
    return `s${new TextEncoder().encode(value).length}:${value}`;
  if (typeof value === "number") {
    assert(Number.isSafeInteger(value), "Expected an integer");
    return `i${value};`;
  }
  if (typeof value === "boolean") return value ? "t" : "f";
  if (Array.isArray(value))
    return `a${value.length}:[${value.map(canonical).join("")}]`;
  assert(
    typeof value === "object" && value !== null,
    "Invalid canonical value",
  );
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `o${keys.length}:{${keys.map((k) => canonical(k) + canonical(obj[k])).join("")}}`;
}
export const hash = (value: unknown): Hex => keccak256(toHex(canonical(value)));
export const randomHex = (): Hex =>
  toHex(crypto.getRandomValues(new Uint8Array(32)));
export const wallet = (s: string) =>
  /^0x[\da-fA-F]{40}$/.test(s) && isAddress(s, { strict: true });
export function lines(text: string) {
  const all = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) => s.normalize("NFC").trim());
  const entries = all.filter(Boolean);
  const seen = new Set<string>();
  const duplicates: number[] = [];
  entries.forEach((s, i) => {
    const key = wallet(s) ? s.toLowerCase() : s;
    if (seen.has(key)) duplicates.push(i + 1);
    seen.add(key);
  });
  return {
    entries,
    duplicates,
    blanks: all.length - entries.length,
    total: all.length,
  };
}
export function normalize(input: Draft): Draft {
  assert(
    input &&
      typeof input.title === "string" &&
      typeof input.description === "string" &&
      typeof input.rules === "string" &&
      Array.isArray(input.entries) &&
      input.entries.every((x) => typeof x === "string" && !/[\r\n]/.test(x)),
    "Invalid giveaway schema",
  );
  const parsed = lines(input.entries.join("\n"));
  assert(
    !parsed.duplicates.length,
    `Duplicate rows: ${parsed.duplicates.join(", ")}`,
  );
  assert(
    parsed.entries.length >= 2 && parsed.entries.length <= 10000,
    "Enter 2–10,000 entries",
  );
  assert(
    parsed.entries.every((x) => new TextEncoder().encode(x).length <= 256),
    "Each entry must be at most 256 UTF-8 bytes",
  );
  assert(
    Number.isInteger(input.winners) &&
      input.winners >= 1 &&
      input.winners <= 100,
    "Choose 1–100 winners",
  );
  assert(
    Number.isInteger(input.reserves) &&
      input.reserves >= 0 &&
      input.reserves <= 100 &&
      input.winners + input.reserves <= parsed.entries.length,
    "Winners and alternates cannot exceed the entry count",
  );
  const title = input.title.normalize("NFC").trim(),
    description = input.description.normalize("NFC").trim(),
    rules = input.rules.normalize("NFC").trim();
  assert(
    title.length >= 3 && title.length <= TITLE_MAX_LENGTH,
    "Title must be 3–120 characters.",
  );
  assert(
    description.length <= DESCRIPTION_MAX_LENGTH,
    "Description must be 4,000 characters or fewer.",
  );
  assert(
    rules.length >= 5 && rules.length <= RULES_MAX_LENGTH,
    "Rules must be 5–4,000 characters.",
  );
  assert(
    input.listed === undefined || typeof input.listed === "boolean",
    "Explorer listing must be enabled or disabled.",
  );
  if (input.weights !== undefined)
    assert(
      Array.isArray(input.weights) &&
        input.weights.length === parsed.entries.length &&
        input.entries.length === parsed.entries.length &&
        input.weights.every(
          (w) => Number.isInteger(w) && w >= 1 && w <= MAX_WEIGHT,
        ),
      "Each entry needs a whole-number weight from 1 to 1,000",
    );
  return {
    title,
    description,
    rules,
    entries: parsed.entries,
    winners: input.winners,
    reserves: input.reserves,
    ...(input.listed !== undefined ? { listed: input.listed } : {}),
    ...(input.weights ? { weights: input.weights } : {}),
  };
}
export function mask(raw: string, id: number): string {
  if (wallet(raw)) return getAddress(raw);
  // Never extract and expose an address from a mixed row. Avoid punctuation leakage.
  if (/0x[\da-fA-F]{6}/.test(raw)) return `Entry #${id}`;
  const mail = raw.match(
    /^([\p{L}\p{N}])[\p{L}\p{N}._+-]*@([\p{L}\p{N}])[\p{L}\p{N}.-]*\.([a-zA-Z]{2,8})$/u,
  );
  if (mail) return `${mail[1]}***@${mail[2]}***.${mail[3]}`;
  if (/^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+){0,3}$/u.test(raw) && raw.length >= 3)
    return raw
      .split(" ")
      .map((x) => `${Array.from(x)[0]}***`)
      .join(" ");
  return `Entry #${id}`;
}
export function makeManifest(
  d: Draft,
  id: string,
  owner: string,
  revision: number,
  salts = d.entries.map(randomHex),
) {
  const privateEntries = d.entries.map((raw, i) => ({
    id: i + 1,
    raw,
    salt: salts[i],
  }));
  const entries = privateEntries.map((e) => ({
    id: e.id,
    label: mask(e.raw, e.id),
    commitment: hash(["lottewy-entry-v1", id, e.id, e.salt, e.raw]),
    ...(d.weights ? { weight: d.weights[e.id - 1] } : {}),
  }));
  const manifest: Manifest = {
    version: 1,
    algorithm: d.weights ? WEIGHTED_ALGORITHM : ALGORITHM,
    normalization: "nfc-trim-v1",
    masking: "strict-v2-en",
    id,
    owner: owner.toLowerCase(),
    revision,
    title: d.title,
    description: d.description,
    rules: d.rules,
    winners: d.winners,
    reserves: d.reserves,
    entries,
  };
  return { manifest, commitment: hash(manifest), privateEntries };
}
export type SelectionStep = {
  draw: number;
  role: "winner" | "alternate";
  entryId: number;
  counter: string;
  derivedHash: Hex;
  sample: string;
  limit: string;
  rejected: number;
  range: number;
  ticket: number;
  intervalStart: number;
  intervalEnd: number;
  remainingCount: number;
  weight: number;
  nearby?: { id: number; position: number; weight?: number }[];
};
export function traceSelection(manifest: Manifest, word: Hex, commitment: Hex) {
  const steps: SelectionStep[] = [];
  const outcome = select(manifest, word, commitment, (step) =>
    steps.push(step),
  );
  return {
    steps,
    outcome,
    domain:
      manifest.algorithm === WEIGHTED_ALGORITHM
        ? "lottewy-weighted-selection-v2"
        : "lottewy-selection-v1",
  };
}
export function select(
  manifest: Manifest,
  word: Hex,
  commitment: Hex,
  onStep?: (step: SelectionStep) => void,
) {
  assert(
    manifest.version === 1 &&
      (manifest.algorithm === ALGORITHM ||
        manifest.algorithm === WEIGHTED_ALGORITHM) &&
      manifest.normalization === "nfc-trim-v1" &&
      (manifest.masking === "strict-v1" || manifest.masking === "strict-v2-en"),
    "Unsupported algorithm",
  );
  assert(
    hash(manifest) === commitment && /^0x[0-9a-fA-F]{64}$/.test(word),
    "Commitment or random word mismatch",
  );
  const n = manifest.entries.length,
    count = manifest.winners + manifest.reserves;
  assert(
    n >= 2 &&
      count <= n &&
      count > 0 &&
      manifest.entries.every((e, i) => e.id === i + 1),
    "Invalid manifest",
  );
  if (manifest.algorithm === WEIGHTED_ALGORITHM)
    return selectWeighted(manifest, word, commitment, onStep);
  assert(
    manifest.entries.every((e) => e.weight === undefined),
    "Equal-chance manifests must not contain weights",
  );
  const pool = manifest.entries.map((e) => e.id);
  let counter = 0n;
  const max = 1n << 256n;
  for (let i = 0; i < count; i++) {
    const range = BigInt(n - i),
      limit = max - (max % range);
    let sample: bigint, derivedHash: Hex;
    const firstCounter = counter;
    do {
      derivedHash = keccak256(
        concatHex([
          toHex("lottewy-selection-v1"),
          commitment,
          word,
          toHex(counter++, { size: 32 }),
        ]),
      );
      sample = BigInt(derivedHash);
    } while (sample >= limit);
    const j = i + Number(sample % range);
    const windowStart = Math.max(i, Math.min(j - 2, n - 5));
    onStep?.({
      draw: i,
      role: i < manifest.winners ? "winner" : "alternate",
      entryId: pool[j],
      counter: (counter - 1n).toString(),
      derivedHash,
      sample: sample.toString(),
      limit: limit.toString(),
      rejected: Number(counter - firstCounter - 1n),
      range: Number(range),
      ticket: Number(sample % range),
      intervalStart: Number(sample % range),
      intervalEnd: Number(sample % range) + 1,
      remainingCount: n - i,
      weight: 1,
      nearby: pool
        .slice(windowStart, windowStart + 5)
        .map((id, slot) => ({ id, position: windowStart + slot - i })),
    });
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return {
    winners: pool.slice(0, manifest.winners),
    reserves: pool.slice(manifest.winners, count),
  };
}
function selectWeighted(
  manifest: Manifest,
  word: Hex,
  commitment: Hex,
  onStep?: (step: SelectionStep) => void,
) {
  const n = manifest.entries.length,
    count = manifest.winners + manifest.reserves;
  assert(
    manifest.entries.every(
      (e) =>
        Number.isInteger(e.weight) && e.weight! >= 1 && e.weight! <= MAX_WEIGHT,
    ),
    "Invalid weighted manifest",
  );
  const tree = new Float64Array(n + 1),
    weights = manifest.entries.map((e) => e.weight!);
  const add = (index: number, delta: number) => {
    for (let i = index + 1; i <= n; i += i & -i) tree[i] += delta;
  };
  weights.forEach((w, i) => add(i, w));
  let total = weights.reduce((a, b) => a + b, 0),
    counter = 0n;
  const max = 1n << 256n,
    selected: number[] = [];
  for (let k = 0; k < count; k++) {
    const range = BigInt(total),
      limit = max - (max % range);
    let sample: bigint, derivedHash: Hex;
    const firstCounter = counter;
    do {
      derivedHash = keccak256(
        concatHex([
          toHex("lottewy-weighted-selection-v2"),
          commitment,
          word,
          toHex(counter++, { size: 32 }),
        ]),
      );
      sample = BigInt(derivedHash);
    } while (sample >= limit);
    let target = Number(sample % range),
      index = 0,
      bit = 2 ** Math.floor(Math.log2(n));
    for (; bit >= 1; bit = Math.floor(bit / 2)) {
      const next = index + bit;
      if (next <= n && tree[next] <= target) {
        target -= tree[next];
        index = next;
      }
    }
    assert(
      index < n && weights[index] > 0,
      "Weighted selection invariant failed",
    );
    const ticket = Number(sample % range),
      intervalStart = ticket - target;
    onStep?.({
      draw: k,
      role: k < manifest.winners ? "winner" : "alternate",
      entryId: manifest.entries[index].id,
      counter: (counter - 1n).toString(),
      derivedHash,
      sample: sample.toString(),
      limit: limit.toString(),
      rejected: Number(counter - firstCounter - 1n),
      range: Number(range),
      ticket,
      intervalStart,
      intervalEnd: intervalStart + weights[index],
      remainingCount: n - k,
      weight: weights[index],
      nearby: weightedNeighbors(weights, index),
    });
    selected.push(manifest.entries[index].id);
    total -= weights[index];
    add(index, -weights[index]);
    weights[index] = 0;
  }
  return {
    winners: selected.slice(0, manifest.winners),
    reserves: selected.slice(manifest.winners),
  };
}
function weightedNeighbors(weights: number[], index: number) {
  const result: { id: number; position: number; weight: number }[] = [];
  let first = index,
    found = 0;
  for (let i = index - 1; i >= 0 && found < 2; i--)
    if (weights[i] > 0) {
      first = i;
      found++;
    }
  for (let i = first; i < weights.length && result.length < 5; i++)
    if (weights[i] > 0)
      result.push({ id: i + 1, position: i, weight: weights[i] });
  for (let i = first - 1; i >= 0 && result.length < 5; i--)
    if (weights[i] > 0)
      result.unshift({ id: i + 1, position: i, weight: weights[i] });
  return result;
}
export const actionTypes = {
  Action: [
    { name: "signer", type: "address" },
    { name: "actionId", type: "string" },
    { name: "actionType", type: "string" },
    { name: "giveawayId", type: "string" },
    { name: "payloadHash", type: "bytes32" },
    { name: "expectedRevision", type: "uint32" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "uint32" },
    { name: "expiresAt", type: "uint32" },
    { name: "audience", type: "string" },
  ],
} as const;
export type Action = {
  signer: `0x${string}`;
  actionId: string;
  actionType: string;
  giveawayId: string;
  payloadHash: Hex;
  expectedRevision: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  audience: string;
};
export const actionData = (message: Action) => ({
  domain: { name: "Lottewy", version: "1", chainId: CHAIN_ID },
  types: actionTypes,
  primaryType: "Action" as const,
  message,
});
