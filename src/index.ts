import { env, waitUntil } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import { createApp } from "./server";
import { processJobs } from "./chain";
import type { Env } from "./config";
import { clientKey } from "./client-key";
const bindings = env as unknown as Env;
createApp(bindings, (work) => waitUntil(work)).listen(3000);
const handler = httpServerHandler({ port: 3000 });
export default {
  ...handler,
  async fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
    environment: Env,
    ctx: ExecutionContext,
  ) {
    if (new URL(request.url).pathname.startsWith("/v1/")) {
      // CF-Connecting-IP is overwritten by the deployed Worker edge; there is no public Node origin.
      const key = clientKey(
        request.headers.get("cf-connecting-ip") || undefined,
      );
      if (environment.EDGE_LIMITER) {
        try {
          if (!(await environment.EDGE_LIMITER.limit({ key })).success)
            return Response.json(
              { code: "RATE_LIMIT", error: "Too many requests. Retry later." },
              { status: 429, headers: { "Retry-After": "60" } },
            );
        } catch {
          return Response.json(
            {
              code: "RATE_LIMIT_UNAVAILABLE",
              error: "Request admission is temporarily unavailable.",
            },
            { status: 503 },
          );
        }
      } else if (environment.MODE === "production")
        return Response.json(
          { code: "RATE_LIMIT_UNAVAILABLE" },
          { status: 503 },
        );
    }
    return handler.fetch!(request, environment, ctx);
  },
  async scheduled(
    _event: ScheduledController,
    environment: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(processJobs(environment));
    ctx.waitUntil(
      environment.DB.prepare("DELETE FROM quotas WHERE expires<?")
        .bind(Math.floor(Date.now() / 1000))
        .run(),
    );
  },
};
