/**
 * DEVELOPMENT ONLY: mock analytics/SEO APIs (Google, Clarity, DataForSEO, Similarweb) and a
 * demo website to crawl. Data is synthetic.
 *
 *   npm run mock:analytics
 *   APIs      http://localhost:8791/<real-host>/<path>   (ANALYTICS_API_BASE_URL)
 *   Demo site http://localhost:8792                       (add it as a website to audit)
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { demoSite, MockAnalytics } from "../dev/mock-analytics/core";

if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
  console.error("Refusing to start the mock analytics servers in production.");
  process.exit(1);
}
const env = (name: string) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Set ${name} (run npm run setup:local, see .env.example).`);
    process.exit(1);
  }
  return v;
};

const apiPort = Number(process.env.MOCK_ANALYTICS_PORT ?? 8791);
const sitePort = Number(process.env.MOCK_SITE_PORT ?? 8792);
const siteUrl = `http://localhost:${sitePort}`;
const sa = JSON.parse(readFileSync(env("MOCK_GOOGLE_SERVICE_ACCOUNT_FILE"), "utf8")) as { client_email: string; private_key: string };
const mock = new MockAnalytics({
  siteUrl, serviceAccountEmail: sa.client_email, serviceAccountPrivateKey: sa.private_key, clarityToken: env("MOCK_CLARITY_TOKEN"),
  dataforseoLogin: env("MOCK_DATAFORSEO_LOGIN"), dataforseoPassword: env("MOCK_DATAFORSEO_PASSWORD"), similarwebKey: env("MOCK_SIMILARWEB_KEY"),
  mixpanelUsername: env("MOCK_MIXPANEL_USERNAME"), mixpanelSecret: env("MOCK_MIXPANEL_SECRET"), databricksToken: env("MOCK_DATABRICKS_TOKEN"),
});

const read = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => resolve(b));
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${apiPort}`);
  const r = mock.handle({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers as Record<string, string>, body: await read(req) });
  res.writeHead(r.status, { "content-type": r.type ?? "application/json", ...(r.headers ?? {}) }).end(r.body);
}).listen(apiPort, () => console.log(`Mock analytics APIs on http://localhost:${apiPort}`));

createServer((req, res) => {
  const url = new URL(req.url ?? "/", siteUrl);
  const r = demoSite(url.pathname, siteUrl);
  res.writeHead(r.status, { "content-type": r.type ?? "text/html" }).end(r.body);
}).listen(sitePort, () => console.log(`Demo website on ${siteUrl}`));
