/**
 * DEVELOPMENT ONLY: serves in-memory mocks of Webflow, Shopify and the Custom CMS API
 * over HTTP on localhost. Publishing to them is simulated and must never be reported
 * as real publishing.
 *
 *   npm run mock:cms
 *   Webflow  http://localhost:8788   (API at /v2, pages at /blog/<slug>)
 *   Shopify  http://localhost:8789   (Admin GraphQL at /admin/api/<version>/graphql.json, pages at /blogs/<blog>/<handle>)
 *   Custom   http://localhost:8790   (API at /api/v1, pages at /posts/<slug>)
 * Each server accepts POST /__mock/reset, /__mock/faults {"method","path","status"} and /__mock/mode {"breakRendering":true}.
 */
import { createServer } from "node:http";
import type { MockCms } from "../dev/mock-cms/common";
import { MockCustomCms } from "../dev/mock-cms/custom";
import { MockShopify } from "../dev/mock-cms/shopify";
import { MockWebflow } from "../dev/mock-cms/webflow";
import { AppError } from "../lib/errors";

if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
  console.error("Refusing to start the mock CMS servers in production.");
  process.exit(1);
}

function required(name: string) {
  const v = process.env[name];
  if (!v) {
    console.error(`Set ${name} (run npm run setup:local, see .env.example).`);
    process.exit(1);
  }
  return v;
}

const servers: { name: string; port: number; make: (baseUrl: string) => MockCms }[] = [
  { name: "webflow", port: Number(process.env.MOCK_WEBFLOW_PORT ?? 8788), make: (baseUrl) => new MockWebflow({ baseUrl, apiToken: required("MOCK_WEBFLOW_TOKEN") }) },
  { name: "shopify", port: Number(process.env.MOCK_SHOPIFY_PORT ?? 8789), make: (baseUrl) => new MockShopify({ baseUrl, accessToken: required("MOCK_SHOPIFY_TOKEN") }) },
  { name: "custom", port: Number(process.env.MOCK_CUSTOM_PORT ?? 8790), make: (baseUrl) => new MockCustomCms({ baseUrl, apiToken: required("MOCK_CUSTOM_TOKEN") }) },
];

const breakPage = (item: { title: string }) => `<html><head><title>${item.title}</title></head><body><h1>${item.title}</h1><p>Template placeholder only.</p></body></html>`;

for (const s of servers) {
  const baseUrl = `http://localhost:${s.port}`;
  let mock = s.make(baseUrl);
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", baseUrl);

    if (url.pathname.startsWith("/__mock/") && req.method === "POST") {
      const data = body ? JSON.parse(body) : {};
      if (url.pathname === "/__mock/reset") mock = s.make(baseUrl);
      if (url.pathname === "/__mock/faults") mock.addFault({ ...data, path: data.path ? new RegExp(data.path) : undefined });
      if (url.pathname === "/__mock/mode" && "breakRendering" in data) mock.renderOverride = data.breakRendering ? breakPage : undefined;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    try {
      const out = await mock.handle(req.method ?? "GET", url.toString(), headers, body || undefined);
      res.writeHead(out.status, out.headers).end(out.text);
    } catch (err) {
      if (err instanceof AppError && err.code === "TIMEOUT") {
        setTimeout(() => res.destroy(), 30_000); // simulate a hung connection
        return;
      }
      res.writeHead(500).end("mock error");
    }
  }).listen(s.port, "127.0.0.1", () => console.log(`[mock-${s.name}] DEVELOPMENT mock listening on ${baseUrl}`));
}
