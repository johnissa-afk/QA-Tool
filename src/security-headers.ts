// ---------------------------------------------------------------------------
// HTTP security header checks.
//
// Evidence-only and deterministic: every issue is derived from the response
// headers the scanner actually received for the scanned navigation, and the
// message names the header that was absent. No claim is made about the
// deployment, CDN, or origin configuration - only about what the response
// carried.
//
// Severities are deliberately MEDIUM/LOW, never HIGH: a missing header is a
// hardening gap, not a demonstrated defect, so it must not flip the QA
// overall status (CRITICAL -> FAIL, HIGH -> REVIEW) for sites that never
// claimed these headers. The findings surface in reports, the evidence
// explorer, and history comparison through the ordinary issue pipeline.
// ---------------------------------------------------------------------------
import { Issue } from "./types.js";

/** Every code this module can emit, in emission order. */
export const SECURITY_HEADER_CODES = [
  "missing-content-security-policy",
  "missing-hsts",
  "missing-x-content-type-options",
  "missing-frame-options",
  "missing-referrer-policy",
] as const;

export type SecurityHeaderCode = (typeof SECURITY_HEADER_CODES)[number];

/** True when the code was emitted by this module (used by QA-side tooling). */
export const isSecurityHeaderCode = (code: string): boolean =>
  (SECURITY_HEADER_CODES as readonly string[]).includes(code);

/**
 * Checks the navigation response headers against the security header set.
 *
 * - Header names are matched case-insensitively; an empty value counts as
 *   absent (an empty Content-Security-Policy protects nothing).
 * - Strict-Transport-Security is only required for https targets; on http
 *   (and on an unparseable URL) it is never reported.
 * - Frame protection is satisfied by either X-Frame-Options or a
 *   `frame-ancestors` directive anywhere in the Content-Security-Policy.
 *
 * The returned issues are in a stable order so reports are deterministic.
 */
export function checkSecurityHeaders(headers: Record<string, string>, finalUrl: string): Issue[] {
  const observed: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) observed[name.toLowerCase()] = String(value).trim();
  const present = (name: string) => Boolean(observed[name]);
  let https = false;
  try {
    https = new URL(finalUrl).protocol === "https:";
  } catch {
    https = false;
  }

  const issues: Issue[] = [];
  if (!present("content-security-policy")) {
    issues.push({ status: "WARNING", code: "missing-content-security-policy", message: "The navigation response has no Content-Security-Policy header." });
  }
  if (https && !present("strict-transport-security")) {
    issues.push({ status: "WARNING", code: "missing-hsts", message: "The HTTPS navigation response has no Strict-Transport-Security header." });
  }
  if (!present("x-content-type-options")) {
    issues.push({ status: "INFO", code: "missing-x-content-type-options", message: "The navigation response has no X-Content-Type-Options header." });
  }
  const csp = observed["content-security-policy"] ?? "";
  if (!present("x-frame-options") && !/(?:^|;)\s*frame-ancestors\b/i.test(csp)) {
    issues.push({ status: "INFO", code: "missing-frame-options", message: "Neither X-Frame-Options nor a Content-Security-Policy frame-ancestors directive protects the page from being framed." });
  }
  if (!present("referrer-policy")) {
    issues.push({ status: "INFO", code: "missing-referrer-policy", message: "The navigation response has no Referrer-Policy header." });
  }
  return issues;
}
