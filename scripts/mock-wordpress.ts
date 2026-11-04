/**
 * DEVELOPMENT ONLY: serves the in-memory mock WordPress over HTTP on localhost.
 * Publishing to it is simulated and must never be reported as real publishing.
 *
 *   npm run mock:wp
 * Fault injection (for manual and E2E testing):
 *   POST /__mock/faults  {"method":"POST","path":"^/wp/v2/posts$","status":503}
 *   POST /__mock/mode    {"breakRendering":true} | {"seoPlugin":"yoast","exposeSeoMeta":true}
 *   POST /__mock/reset
 */
import { createServer } from "node:http";
import { MockWordPress } from "../dev/mock-wordpress/core";
import { AppError } from "../lib/errors";

if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
  console.error("Refusing to start the mock WordPress server in production.");
  process.exit(1);
}

const port = Number(process.env.MOCK_WP_PORT ?? 8787);
const username = process.env.MOCK_WP_USER ?? "demo-editor";
const applicationPassword = (process.env.MOCK_WP_APP_PASSWORD ?? "").replace(/\s+/g, "");
if (!/^[A-Za-z0-9]{24}$/.test(applicationPassword)) {
  console.error("Set MOCK_WP_APP_PASSWORD to a 24-character alphanumeric test value (see .env.example).");
  process.exit(1);
}

const baseUrl = `http://localhost:${port}`;
let wp = fresh();
function fresh() {
  return new MockWordPress({ baseUrl, username, applicationPassword, seoPlugin: "yoast", exposeSeoMeta: true, siteName: "Mock WordPress (development)" });
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url ?? "/", baseUrl);

  if (url.pathname.startsWith("/__mock/") && req.method === "POST") {
    const data = body ? JSON.parse(body) : {};
    if (url.pathname === "/__mock/reset") wp = fresh();
    if (url.pathname === "/__mock/faults") wp.addFault({ ...data, path: data.path ? new RegExp(data.path) : undefined });
    if (url.pathname === "/__mock/mode") {
      if ("breakRendering" in data) wp.opts.renderOverride = data.breakRendering ? (p) => `<html><head><title>${p.title}</title></head><body><h1>${p.title}</h1><p>Theme placeholder only.</p></body></html>` : undefined;
      if ("seoPlugin" in data) wp.opts.seoPlugin = data.seoPlugin;
      if ("exposeSeoMeta" in data) wp.opts.exposeSeoMeta = data.exposeSeoMeta;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, posts: wp.posts.size }));
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
  try {
    const out = await wp.handle(req.method ?? "GET", url.toString(), headers, body || undefined);
    res.writeHead(out.status, out.headers).end(out.text);
  } catch (err) {
    if (err instanceof AppError && err.code === "TIMEOUT") {
      setTimeout(() => res.destroy(), 30_000); // simulate a hung connection
      return;
    }
    res.writeHead(500).end("mock error");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`[mock-wordpress] DEVELOPMENT mock listening on ${baseUrl} (user "${username}")`);
});
