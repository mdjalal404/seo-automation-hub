import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAgentsForTests, safeFetch } from "@/lib/security/safe-fetch";

let server: Server;
let base = "";
let lastAuth: Record<string, string | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastAuth[req.url ?? ""] = req.headers.authorization;
    if (req.url === "/slow") return setTimeout(() => res.end("late"), 2000);
    if (req.url === "/big") return res.end("x".repeat(20_000));
    if (req.url === "/redirect-same") return res.writeHead(302, { location: "/final" }).end();
    if (req.url === "/redirect-other") return res.writeHead(302, { location: base.replace("127.0.0.1", "localhost") + "/final" }).end();
    if (req.url === "/redirect-metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (req.url === "/post-redirect") return res.writeHead(301, { location: "/final" }).end();
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => server.close());
afterEach(() => {
  delete process.env.ALLOW_PRIVATE_NETWORK_TARGETS;
  delete process.env.APP_ENV;
  resetAgentsForTests();
});

function devMode() {
  process.env.APP_ENV = "test";
  process.env.ALLOW_PRIVATE_NETWORK_TARGETS = "true";
}

describe("safeFetch", () => {
  it("refuses private targets by default", async () => {
    await expect(safeFetch(`${base}/`)).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("never allows private targets in production even if the flag is set", async () => {
    process.env.APP_ENV = "production";
    process.env.ALLOW_PRIVATE_NETWORK_TARGETS = "true";
    await expect(safeFetch(`${base}/`)).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("follows same-origin redirects and drops Authorization cross-origin", async () => {
    devMode();
    const same = await safeFetch(`${base}/redirect-same`, { headers: { authorization: "Basic abc" } });
    expect(same.text).toBe("ok");
    expect(lastAuth["/final"]).toBe("Basic abc");
    lastAuth = {};
    await safeFetch(`${base}/redirect-other`, { headers: { authorization: "Basic abc" } });
    expect(lastAuth["/final"]).toBeUndefined();
  });

  it("does not follow redirects for write requests", async () => {
    devMode();
    await expect(safeFetch(`${base}/post-redirect`, { method: "POST", body: "{}" })).rejects.toThrow(/redirected a write request/);
  });

  it("enforces timeouts and response size limits", async () => {
    devMode();
    await expect(safeFetch(`${base}/slow`, { timeoutMs: 200 })).rejects.toMatchObject({ code: "TIMEOUT", retryable: true, ambiguous: false });
    await expect(safeFetch(`${base}/slow`, { method: "POST", body: "{}", timeoutMs: 200 })).rejects.toMatchObject({ code: "TIMEOUT", ambiguous: true });
    await expect(safeFetch(`${base}/big`, { maxBytes: 1000 })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });
});
