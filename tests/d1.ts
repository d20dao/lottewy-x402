import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync("migrations/" + file, "utf8"));
  const prepare = (sql: string) => {
    let args: any[] = [];
    return {
      bind(...values: any[]) {
        args = values;
        return this;
      },
      async first() {
        return sqlite.prepare(sql).get(...args) || null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...args) };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  };
  let queue = Promise.resolve();
  return {
    sqlite,
    prepare,
    batch(statements: any[]) {
      const operation = queue.then(async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      });
      queue = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
  };
}
