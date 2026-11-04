/**
 * Structured JSON logger. Values under sensitive keys are redacted recursively,
 * and strings that look like Basic/Bearer credentials are masked.
 */
type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|credential|api[-_]?key|encryption|service[-_]?role/i;
const CREDENTIAL_VALUE = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return value.replace(CREDENTIAL_VALUE, "$1 [REDACTED]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), code: (value as { code?: unknown }).code };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (process.env.LOG_LEVEL === "silent") return;
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as object) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};

/** Operational metrics are emitted as structured log events (`metric.*`) for log-based dashboards. */
export function metric(name: string, value: number, tags: Record<string, string | number | boolean> = {}) {
  emit("info", `metric.${name}`, { value, ...tags });
}
