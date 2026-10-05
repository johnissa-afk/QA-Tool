// ---------------------------------------------------------------------------
// Shared HTML escaping for every generated report (scan, analysis, tests).
// Single definition so escaping rules cannot drift between reports.
// ---------------------------------------------------------------------------

export const escapeHtml = (value: string | number | boolean | null | undefined): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Only these schemes may appear in a rendered href. Anything else
// (javascript:, data:, vbscript:, …) is reported as plain text so a
// scanned page cannot ship click-to-execute payloads into a report.
const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const BLOCKED_SCHEME = "about:blank#blocked-scheme";

/**
 * Returns an escaped URL that is safe to place in an `href` attribute.
 * Unsafe or unparseable schemes collapse to a harmless placeholder; the
 * caller still shows the original string as text, so nothing is hidden.
 */
export const safeHref = (value: string | number | boolean | null | undefined): string => {
  const raw = String(value ?? "").trim();
  if (raw === "") return BLOCKED_SCHEME;
  // Scheme-relative and root-relative references are same-origin and safe.
  if (raw.startsWith("/") || raw.startsWith("#") || raw.startsWith("./") || raw.startsWith("../")) {
    return escapeHtml(raw);
  }
  let scheme: string;
  try {
    scheme = new URL(raw).protocol.toLowerCase();
  } catch {
    return escapeHtml(raw.startsWith("file:") ? BLOCKED_SCHEME : raw);
  }
  if (!SAFE_URL_SCHEMES.has(scheme)) return BLOCKED_SCHEME;
  return escapeHtml(raw);
};
