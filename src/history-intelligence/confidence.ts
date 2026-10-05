// ---------------------------------------------------------------------------
// Phase 7B — explainable confidence.
//
// Confidence is never a percentage. It is a documented HIGH / MEDIUM / LOW /
// INSUFFICIENT chosen ONLY from explainable factors: how many ordered runs the
// claim rests on, whether the pattern is contradicted, whether the underlying
// evidence was directly verified/reproduced, and whether the area was
// meaningfully covered. The reasons are written down alongside the level so a
// reader can see exactly why a pattern is (or is not) trusted.
// ---------------------------------------------------------------------------
import type { HistoricalConfidence } from "./types.js";

export type ConfidenceInputs = {
  /** Ordered runs the claim may rest on (only validly-ordered runs). */
  orderedRunCount: number;
  /** How many of those runs actually observed the entity (support weight). */
  observedRunCount: number;
  /** Contradicting observations (reproduced vs observed-clear) across runs. */
  contradictions: number;
  /** Whether the entity carries direct verification/reproduction evidence. */
  verified: boolean;
  /** Whether the relevant area was meaningfully tested in the deciding run. */
  covered: boolean;
  /** Whether the pattern depends on the absence of evidence rather than on
   *  observed proof (e.g. a vanished finding that was never re-tested). */
  gapDependent: boolean;
};

export type DerivedConfidence = {
  confidence: HistoricalConfidence;
  reason: string;
};

export function deriveConfidence(input: ConfidenceInputs): DerivedConfidence {
  const parts: string[] = [];
  if (input.orderedRunCount < 2) {
    return {
      confidence: "INSUFFICIENT",
      reason: "fewer than 2 comparably ordered runs — no historical pattern can be claimed",
    };
  }
  if (input.contradictions > 0) {
    parts.push(`contradicting evidence across runs (${input.contradictions} observation(s) conflicted)`);
  }
  if (input.gapDependent) {
    parts.push("pattern depends on an absence that was not directly re-tested");
  }
  if (input.verified) {
    parts.push("directly reproduced/verified in the evidence");
  }
  if (input.covered) {
    parts.push("the relevant area was meaningfully exercised in the deciding run");
  }
  if (input.observedRunCount >= 2) {
    parts.push(`${input.observedRunCount} runs observed the pattern`);
  }

  if (input.contradictions > 0 && input.orderedRunCount < 3) {
    return { confidence: "LOW", reason: parts.join("; ") || "contradicted pattern on a two-run history" };
  }
  if (input.contradictions > 0) {
    return {
      confidence: "MEDIUM",
      reason: `pattern holds but ${parts.length ? parts.join("; ") : "evidence conflicts"}`,
    };
  }
  if (input.orderedRunCount >= 3 && input.verified && !input.gapDependent && input.observedRunCount >= 2) {
    return { confidence: "HIGH", reason: `${parts.join("; ")}; pattern is consistent across ${input.orderedRunCount} ordered runs` };
  }
  if (input.observedRunCount >= 2 || (input.orderedRunCount >= 3 && !input.gapDependent)) {
    return { confidence: "MEDIUM", reason: parts.join("; ") || "consistent pattern across runs" };
  }
  return { confidence: "LOW", reason: parts.join("; ") || "a single, weak or unverified observation" };
}