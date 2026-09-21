import { assert, hash } from "../shared/core";
// D1 caps each value AND combined table row at 2 MB. Keep private JSON out of
// the public-manifest row, including drafts below the individual-value cap.
export function storeJson(db: D1Database, key: string, value: unknown) {
  const text = JSON.stringify(value),
    parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 64000, text.length);
    if (
      end < text.length &&
      /[\uD800-\uDBFF]/.test(text[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(text[end])
    )
      end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return {
    reference: JSON.stringify({
      storage: "json-chunks-v1",
      key,
      count: parts.length,
      hash: hash(text),
    }),
    statements: parts.map((part, index) =>
      db
        .prepare(
          "INSERT INTO json_chunks(object_key,part,value) VALUES (?,?,?)",
        )
        .bind(key, index, part),
    ),
  };
}
export async function loadJson(db: D1Database, value: string) {
  const ref = JSON.parse(value);
  if (ref?.storage !== "json-chunks-v1") return ref;
  assert(
    typeof ref.key === "string" &&
      Number.isInteger(ref.count) &&
      ref.count > 0 &&
      ref.count <= 256,
    "Invalid stored JSON reference",
  );
  const chunks = await db
    .prepare(
      "SELECT part,value FROM json_chunks WHERE object_key=? ORDER BY part",
    )
    .bind(ref.key)
    .all<{ part: number; value: string }>();
  assert(
    chunks.results.length === ref.count &&
      chunks.results.every((part, index) => part.part === index),
    "Stored JSON is incomplete",
  );
  const text = chunks.results.map((part) => part.value).join("");
  assert(hash(text) === ref.hash, "Stored JSON integrity mismatch");
  return JSON.parse(text);
}
