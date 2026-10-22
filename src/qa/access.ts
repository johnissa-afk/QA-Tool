export type AccessStatus =
  | "accessible"
  | "authentication-required"
  | "login-required"
  | "access-blocked"
  | "bot-protection"
  | "unknown";

export type AuthenticationType = "none" | "basic" | "digest" | "bearer" | "negotiate" | "ntlm" | "unknown";

export type AccessDetection = {
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  accessStatus: AccessStatus;
  authenticationType: AuthenticationType;
  challenge: string | null;
  redirectDestination: string | null;
  reason: string;
  continueScan: boolean;
  humanReview: boolean;
};

export type AccessDetectionInput = {
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  headers?: Record<string, string>;
  body?: string;
};

const LOGIN_PATH = /\/(?:login|signin|sign-in|auth\/login|account\/login)(?:\/|$)/i;
const LOGIN_EVIDENCE = /<form\b[\s\S]*?(?:password|sign[ -]?in|log[ -]?in)|\b(?:sign[ -]?in|log[ -]?in)\b[\s\S]*?(?:password|<form\b)/i;
const BOT_EVIDENCE = /cloudflare|cf-chl-|challenge-platform|verify you are human|attention required|request blocked|you have been blocked|bot detection|security challenge/i;
const ACCESS_BLOCK_EVIDENCE = /access denied|forbidden|request blocked|you have been blocked/i;

// A page that loaded successfully (2xx/3xx) is only a challenge when it LOOKS like one.
// Mentioning "cloudflare", loading /cdn-cgi/challenge-platform/scripts/jsd/main.js (injected
// into ordinary Cloudflare-fronted pages) or containing the word "forbidden" proves nothing.
const CHALLENGE_TITLE = /^\s*(?:just a moment|attention required|checking your browser|verify(?:ing)? you are human|security check|access denied|request blocked|you have been blocked|403 forbidden)/i;
const BOT_TITLE = /^\s*(?:just a moment|attention required|checking your browser|verify(?:ing)? you are human|security check)/i;
const STRONG_CHALLENGE_MARKERS = /cf-chl-|cf_chl_opt|id=["']challenge-form["']|class=["'][^"']*cf-turnstile|\/cdn-cgi\/challenge-platform\/h\/[a-z]\/orchestrate\/|chl_page/i;
const THIN_PAGE_TEXT_LENGTH = 400;

function titleOf(body: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  return match ? match[1]!.replace(/\s+/g, " ").trim() : null;
}

function visibleText(body: string): string {
  return body
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function authenticationTypeOf(challenge: string | null): AuthenticationType {
  if (!challenge) return "none";
  const value = challenge.toLowerCase();
  if (/\bbasic\b/.test(value)) return "basic";
  if (/\bdigest\b/.test(value)) return "digest";
  if (/\bbearer\b/.test(value)) return "bearer";
  if (/\bnegotiate\b/.test(value)) return "negotiate";
  if (/\bntlm\b/.test(value)) return "ntlm";
  return "unknown";
}

function result(input: AccessDetectionInput, values: Omit<AccessDetection, "url" | "finalUrl" | "httpStatus">): AccessDetection {
  return { url: input.url, finalUrl: input.finalUrl, httpStatus: input.httpStatus, ...values };
}

export function detectAccess(input: AccessDetectionInput): AccessDetection {
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const challenge = headers["www-authenticate"] ?? null;
  const authenticationType = authenticationTypeOf(challenge);
  const body = input.body ?? "";
  const redirected = input.finalUrl !== input.url ? input.finalUrl : null;

  if (input.httpStatus === 401) {
    return result(input, {
      accessStatus: "authentication-required",
      authenticationType: challenge ? authenticationType : "unknown",
      challenge,
      redirectDestination: redirected,
      reason: "The target returned HTTP 401 and requires authentication before normal scanning can proceed.",
      continueScan: false,
      humanReview: true,
    });
  }

  const status = input.httpStatus;
  const succeeded = status != null && status >= 200 && status < 400;
  const title = titleOf(body);
  const strongMarker = STRONG_CHALLENGE_MARKERS.test(body);
  const challengeTitle = title !== null && CHALLENGE_TITLE.test(title);
  const statusBlocked = status === 403 || status === 429;
  const text = visibleText(body);
  const thinPage = text.length < THIN_PAGE_TEXT_LENGTH;
  // A near-empty page whose only visible words are a block/challenge message (e.g. a bare
  // "Access Denied" with HTTP 200). Big real pages that merely contain such a word do not match.
  const thinBlockText = thinPage && (ACCESS_BLOCK_EVIDENCE.test(text) || BOT_EVIDENCE.test(text));
  // Non-success responses (e.g. a 503 "under attack" page, or no response at all) keep the
  // broad text evidence; successful pages need a specific challenge signal.
  const textBlocked = !succeeded && (ACCESS_BLOCK_EVIDENCE.test(body) || BOT_EVIDENCE.test(body));
  const successChallenge = succeeded && (challengeTitle || (strongMarker && thinPage) || thinBlockText);

  if (statusBlocked || textBlocked || successChallenge) {
    const bot = succeeded
      ? strongMarker || (title !== null && BOT_TITLE.test(title)) || (thinBlockText && BOT_EVIDENCE.test(text))
      : BOT_EVIDENCE.test(body) && (statusBlocked || /challenge|blocked|cloudflare/i.test(body));
    const signal = statusBlocked
      ? `HTTP ${status}`
      : succeeded
        ? challengeTitle ? `page title "${title}"` : "challenge markers or block wording on an almost empty page"
        : "block/challenge text in a non-success response";
    return result(input, {
      accessStatus: bot ? "bot-protection" : "access-blocked",
      authenticationType,
      challenge,
      redirectDestination: redirected,
      reason: (bot
        ? "The target appears to require a bot or security challenge before automated scanning can proceed."
        : `The target returned HTTP ${input.httpStatus ?? "an access-control response"} and automated scanning cannot proceed.`) + ` Detected via: ${signal}.`,
      continueScan: false,
      humanReview: true,
    });
  }

  if (LOGIN_PATH.test(input.finalUrl) && LOGIN_EVIDENCE.test(body)) {
    return result(input, {
      accessStatus: "login-required",
      authenticationType,
      challenge,
      redirectDestination: redirected,
      reason: "The target redirected to an application login page; normal scanning requires a human-approved session.",
      continueScan: false,
      humanReview: true,
    });
  }

  if (input.httpStatus != null && input.httpStatus >= 200 && input.httpStatus < 400) {
    return result(input, {
      accessStatus: "accessible",
      authenticationType,
      challenge,
      redirectDestination: redirected,
      reason: "The target responded successfully and no access prerequisite was detected.",
      continueScan: true,
      humanReview: false,
    });
  }

  return result(input, {
    accessStatus: "unknown",
    authenticationType,
    challenge,
    redirectDestination: redirected,
    reason: "The target response did not provide enough deterministic evidence to classify access.",
    continueScan: false,
    humanReview: true,
  });
}