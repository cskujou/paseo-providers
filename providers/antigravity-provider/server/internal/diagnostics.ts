import type { ProviderError } from "@getpaseo/plugin/server/provider";

const MAX_DIAGNOSTIC_LENGTH = 16 * 1024;
const secretKey =
  /authorization|cookie|password|passwd|secret|token(?!s$)|api[_-]?key|credential|private[_-]?key/i;
const contentKey =
  /prompt|^(messages|content|body|input|output|rawInput|rawOutput|command|commandLine|env|args)$/i;

export function redactDiagnosticText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted private key]",
    )
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(
      /"((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization))"\s*:\s*"[^"\r\n]*"/gi,
      '"$1":"[redacted]"',
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted token]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted account]");
}

function redactValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): unknown {
  if (typeof value === "string")
    return redactDiagnosticText(value).slice(0, MAX_DIAGNOSTIC_LENGTH);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (value === undefined) return undefined;
  if (typeof value !== "object") return String(value);
  if (depth > 8 || seen.has(value)) return "[truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value
        .slice(0, 100)
        .map((entry) => redactValue(entry, depth + 1, seen));
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      result[key] =
        secretKey.test(key) || contentKey.test(key)
          ? "[redacted]"
          : redactValue(entry, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function diagnosticDetails(value: unknown): string {
  const encoded = JSON.stringify(redactValue(value)) ?? "";
  return encoded.length > MAX_DIAGNOSTIC_LENGTH
    ? encoded.slice(0, MAX_DIAGNOSTIC_LENGTH) + "…[truncated]"
    : encoded;
}

export class AntigravityError extends Error {
  constructor(
    message: string,
    readonly code = "ANTIGRAVITY_ERROR",
    readonly diagnostic?: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AntigravityError";
  }
}

export function formatDiagnostic(message: string): string {
  if (/auth|sign.in|log.in|unauthenticated|credential/i.test(message)) {
    return "Antigravity authentication failed. Run agy and sign in, then retry.";
  }
  return redactDiagnosticText(message);
}

export function providerError(failure: unknown): ProviderError {
  const message = failure instanceof Error ? failure.message : String(failure);
  const code =
    failure instanceof AntigravityError ? failure.code : "ANTIGRAVITY_ERROR";
  const diagnostic =
    failure instanceof AntigravityError ? failure.diagnostic : undefined;
  return {
    message: formatDiagnostic(message),
    code,
    ...(diagnostic ? { diagnostic: redactDiagnosticText(diagnostic) } : {}),
  };
}

// Builtin plugin stdout/stderr are collected by Paseo into its daemon log. Never
// log prompt frames, tool content, environment, or unredacted RPC data here.
export function logDiagnostic(
  event: string,
  fields: Record<string, unknown> = {},
  failure?: unknown,
): void {
  const record = diagnosticDetails({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
    ...(failure === undefined ? {} : { error: providerError(failure) }),
  });
  if (failure === undefined) console.info("[antigravity] " + record);
  else console.error("[antigravity] " + record);
}
