import { describe, expect, it } from "vitest";
import { credentialAad, decryptSecret, encryptSecret, needsReencryption } from "@/lib/security/crypto";
import { assertSafeTarget, isPrivateAddress, normalizeWebsiteUrl } from "@/lib/security/url";
import { redact } from "@/lib/observability/logger";

const strict = { allowPrivate: false };

describe("URL policy (SSRF)", () => {
  it.each([
    "http://example.com", // http not allowed in strict mode
    "https://localhost",
    "https://127.0.0.1",
    "https://10.1.2.3",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]",
    "https://[fd00::1]",
    "https://[::ffff:127.0.0.1]",
    "https://metadata.google.internal",
    "https://printer.local",
    "https://user:pass@example.com",
    "https://example.com:8443",
    "file:///etc/passwd",
    "gopher://example.com",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertSafeTarget(url, strict)).toThrow();
  });

  it("accepts public https URLs", () => {
    expect(assertSafeTarget("https://example.com/wp-json/", strict).hostname).toBe("example.com");
  });

  it("classifies private addresses including mapped IPv6", () => {
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("normalizes website URLs", () => {
    expect(normalizeWebsiteUrl("Example.COM/blog/", strict)).toBe("https://example.com/blog");
    expect(() => normalizeWebsiteUrl("https://example.com/?p=1", strict)).toThrow(/query/);
    expect(normalizeWebsiteUrl("http://localhost:8787", { allowPrivate: true })).toBe("http://localhost:8787");
  });
});

describe("credential encryption", () => {
  const aad = credentialAad("org-1", "site-1");

  it("round-trips and uses a random IV", () => {
    const a = encryptSecret("secret-value", aad);
    const b = encryptSecret("secret-value", aad);
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret-value");
    expect(a.startsWith("v1:k1:")).toBe(true);
    expect(decryptSecret(a, aad)).toBe("secret-value");
  });

  it("fails when bound to another tenant or tampered with", () => {
    const env = encryptSecret("secret-value", aad);
    expect(() => decryptSecret(env, credentialAad("org-2", "site-1"))).toThrow(/could not be decrypted/);
    const parts = env.split(":");
    parts[4] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"), aad)).toThrow();
  });

  it("supports key rotation with previous keys", () => {
    const old = encryptSecret("rotate-me", aad);
    const prevKey = process.env.CREDENTIAL_ENCRYPTION_KEY!;
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.CREDENTIAL_ENCRYPTION_KEY_ID = "k2";
    process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS = `k1:${prevKey}`;
    try {
      expect(decryptSecret(old, aad)).toBe("rotate-me");
      expect(needsReencryption(old)).toBe(true);
      expect(needsReencryption(encryptSecret("x", aad))).toBe(false);
    } finally {
      process.env.CREDENTIAL_ENCRYPTION_KEY = prevKey;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_ID;
      delete process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS;
    }
  });
});

describe("log redaction", () => {
  it("removes secrets by key and credential-shaped values", () => {
    const out = redact({
      applicationPassword: "abcd efgh",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
      message: "Request failed with Basic dXNlcjpwYXNz header",
      nested: { serviceRoleKey: "x", ok: "visible" },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("dXNlcjpwYXNz");
    expect(JSON.stringify(out)).not.toContain("abcd efgh");
    expect(JSON.stringify(out)).toContain("visible");
  });
});
