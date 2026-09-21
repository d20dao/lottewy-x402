import { execFileSync } from "node:child_process";
const allowed = new Set([
  "README.md",
  "UI-CONTEXT.md",
  "docs/IMPLEMENTATION.md",
]);
const paths = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
let failed = false;
for (const path of paths) {
  if (!/\.md$/i.test(path)) continue;
  const content = execFileSync("git", ["show", `:${path}`], {
    encoding: "utf8",
  });
  if (!allowed.has(path) || /[çğıöşüÇĞİÖŞÜ]/u.test(content)) {
    console.error(
      `Blocked Markdown file: ${path}. Turkish/private Markdown must never be committed.`,
    );
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("Staged Markdown policy passed.");
