// ---------------------------------------------------------------------------
// Secret redaction for the EXECUTOR layer.
//
// Credentials and API keys are environment-only and must never be serialized.
// Any captured DOM text, error message, or attribute value passes through the
// redactor before it is stored or printed.
// ---------------------------------------------------------------------------
export type Redactor = (text: string) => string;

export function buildRedactor(env: NodeJS.ProcessEnv = process.env): Redactor {
  // SMTP credentials join the same list as every other secret, so an email
  // transport reuses this redactor instead of keeping a second one that could
  // drift out of step with it.
  const secrets = [
    env.QA_USERNAME, env.QA_PASSWORD, env.QA_BASIC_AUTH_USER, env.QA_BASIC_AUTH_PASSWORD, env.QA_AUTHORIZATION,
    env.AI_API_KEY,
    env.SMTP_USER, env.SMTP_PASSWORD,
  ]
    .filter((value): value is string => typeof value === "string" && value.length >= 4)
    .filter(value => !["true", "false", "null", "undefined"].includes(value));

  return (text: string): string => {
    let redacted = text;
    for (const secret of secrets) redacted = redacted.split(secret).join("***");
    redacted = redacted.replace(/(Bearer\s+)\S+/gi, "$1***");
    redacted = redacted.replace(/(authorization[=:]\s*)[^\s"']+/gi, "$1***");
    redacted = redacted.replace(/(password[=:]\s*)[^\s"']+/gi, "$1***");
    redacted = redacted.replace(/(token[=:]\s*)[^\s"']+/gi, "$1***");
    redacted = redacted.replace(/(api[_-]?key[=:]\s*)[^\s"']+/gi, "$1***");
    // An SMTP URI or a `user:password@host` authority is a credential even when
    // no environment value matched it.
    redacted = redacted.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1***:***@");
    redacted = redacted.replace(/(\bfrom[=:]\s*)["']?[^\s"',]+:[^\s"',]*@/gi, "$1***:***@");
    return redacted;
  };
}

/** Recursively redacts every string inside a value. */
export function redactObject<T>(value: T, redact: Redactor): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(item => redactObject(item, redact)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactObject(entry, redact)]),
    ) as unknown as T;
  }
  return value;
}