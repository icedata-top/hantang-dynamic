const SENSITIVE_KEY_RE =
  /cookie|sessdata|csrf|bili_jct|access_key|authorization|token|password|secret|database_url|url/i;

const CONNECTION_RE = /\b(postgres(?:ql)?:\/\/)([^:\s/@]+):([^@\s]+)@/gi;
// Only redact `name=value` / `name: value` pairs. Requiring the separator keeps
// filenames such as `.cookies_507256226.txt` readable in diagnostics.
const SECRET_PAIR_RE =
  /\b(SESSDATA|bili_jct|csrf|access_key|Cookie)\s*=\s*([^;\s]+)/gi;
const AUTHORIZATION_RE = /\b(Authorization)\s*[:=]\s*([^\n,;]+)/gi;
const COOKIE_HEADER_RE = /\b(Cookie)\s*:\s*([^\n]+)/gi;

function redactString(value: string): string {
  return value
    .replace(CONNECTION_RE, "$1[redacted]:[redacted]@")
    .replace(COOKIE_HEADER_RE, "$1=[redacted]")
    .replace(AUTHORIZATION_RE, "$1=[redacted]")
    .replace(SECRET_PAIR_RE, "$1=[redacted]");
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[redacted-depth]";
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_RE.test(key)
      ? "[redacted]"
      : redactSensitive(item, depth + 1);
  }
  return output;
}

export function redactForLog(value: unknown): string {
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    const message = `${value.name}: ${value.message}${
      value.stack ? `\n${value.stack}` : ""
    }`;
    return redactString(message);
  }
  return JSON.stringify(redactSensitive(value));
}
