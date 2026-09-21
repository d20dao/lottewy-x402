import { readFileSync, readdirSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
const staged = process.argv.includes("--staged");
const publicKeys = new Set([
  "VITE_WALLETCONNECT_PROJECT_ID",
  "TURNSTILE_SITE_KEY",
]);
const secrets = [
  ...new Set(
    [".env", ".dev.vars"].filter(existsSync).flatMap((path) =>
      Object.entries(parseEnv(readFileSync(path, "utf8")))
        .filter(([key, value]) => !publicKeys.has(key) && value.length >= 16)
        .map(([, value]) => value),
    ),
  ),
];
const paths = execFileSync(
  "git",
  staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split(String.fromCharCode(0))
  .filter(Boolean);
if (!staged && existsSync("dist")) {
  const walk = (dir) => {
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      const path = dir + "/" + file.name;
      if (file.isDirectory()) walk(path);
      else paths.push(path);
    }
  };
  walk("dist");
}
let hits = 0,
  checked = 0;
const forbidden =
  /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|.+\.(?:pem|p12|pfx|key))$/i;
const credentialPattern =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AIza[A-Za-z0-9_-]{35})/;
for (const path of new Set(paths)) {
  if (path !== ".env.example" && forbidden.test(path.split("/").at(-1))) {
    console.error("Forbidden credential file: " + path);
    hits++;
    continue;
  }
  const buffer = staged
    ? execFileSync("git", ["show", ":" + path], { maxBuffer: 32 * 1024 * 1024 })
    : readFileSync(path);
  checked++;
  if (
    secrets.some((secret) => buffer.includes(Buffer.from(secret))) ||
    credentialPattern.test(buffer.toString("utf8"))
  ) {
    console.error("Potential credential exposure in " + path);
    hits++;
  }
}
console.log(
  "Secret scan: " +
    checked +
    " " +
    (staged ? "staged" : "candidate/build") +
    " files checked; " +
    hits +
    " matches.",
);
if (hits) process.exit(1);
