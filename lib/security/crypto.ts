import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "@/lib/errors";

/**
 * Authenticated encryption (AES-256-GCM) for CMS credentials.
 *
 * Envelope: v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>
 * The associated data binds a ciphertext to its organization and website, so an
 * encrypted blob copied into another tenant's row fails to decrypt.
 *
 * Rotation: set a new CREDENTIAL_ENCRYPTION_KEY + CREDENTIAL_ENCRYPTION_KEY_ID and move
 * the old one to CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS ("k1:<base64>,k0:<base64>").
 * Old envelopes keep decrypting; `needsReencryption` flags them for re-encryption.
 */
type Keyring = { currentId: string; keys: Map<string, Buffer> };

function loadKeyring(): Keyring {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new AppError("CONFIG_MISSING", "CREDENTIAL_ENCRYPTION_KEY is not configured.");
  const current = Buffer.from(raw, "base64");
  if (current.length !== 32) throw new AppError("CONFIG_MISSING", "CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (base64).");
  const currentId = process.env.CREDENTIAL_ENCRYPTION_KEY_ID || "k1";
  const keys = new Map<string, Buffer>([[currentId, current]]);
  for (const entry of (process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, b64] = entry.split(":");
    const key = Buffer.from(b64 ?? "", "base64");
    if (id && key.length === 32 && !keys.has(id)) keys.set(id, key);
  }
  return { currentId, keys };
}

export function encryptSecret(plaintext: string, associatedData: string): string {
  const { currentId, keys } = loadKeyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.get(currentId)!, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", currentId, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(envelope: string, associatedData: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 5 || parts[0] !== "v1") throw new AppError("INTERNAL", "Unrecognized credential format.");
  const [, keyId, ivB64, tagB64, ctB64] = parts;
  const key = loadKeyring().keys.get(keyId);
  if (!key) throw new AppError("CONFIG_MISSING", `Encryption key "${keyId}" is not available. Check key rotation settings.`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("INTERNAL", "Stored credentials could not be decrypted. Reconnect the website.");
  }
}

export function needsReencryption(envelope: string): boolean {
  return envelope.split(":")[1] !== loadKeyring().currentId;
}

export type { WordPressCredentials } from "@/lib/cms/credentials";

export function credentialAad(organizationId: string, websiteId: string) {
  return `cms:${organizationId}:${websiteId}`;
}
