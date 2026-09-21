import { isIP } from "node:net";

/** Group IPv6 callers by /64 so address rotation within one allocation is not a quota bypass. */
export function clientKey(value: string | undefined) {
  if (!value) return "unknown";
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind !== 6) return "unknown";
  const normalized = new URL(`http://[${value}]/`).hostname
    .slice(1, -1)
    .toLowerCase();
  const [head, tail = ""] = normalized.split("::");
  const left = head ? head.split(":") : [],
    right = tail ? tail.split(":") : [];
  const groups = normalized.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return (
    groups
      .slice(0, 4)
      .map((s) => parseInt(s, 16).toString(16))
      .join(":") + "::/64"
  );
}
