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

  if (input.httpStatus === 403 || input.httpStatus === 429 || ACCESS_BLOCK_EVIDENCE.test(body) || BOT_EVIDENCE.test(body)) {
    const bot = BOT_EVIDENCE.test(body) && (input.httpStatus === 403 || input.httpStatus === 429 || /challenge|blocked|cloudflare/i.test(body));
    return result(input, {
      accessStatus: bot ? "bot-protection" : "access-blocked",
      authenticationType,
      challenge,
      redirectDestination: redirected,
      reason: bot
        ? "The target appears to require a bot or security challenge before automated scanning can proceed."
        : `The target returned HTTP ${input.httpStatus ?? "an access-control response"} and automated scanning cannot proceed.`,
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