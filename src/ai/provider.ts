import { IntentCategory, Priority } from "../types.js";
import { buildRedactor, redactObject } from "../executor/redact.js";
import type { FlowAnalysisEnhancement, FlowDigest, FlowPriority } from "../flow/types.js";
import { validateIntelligenceEnhancement } from "../intelligence/index.js";
import { SEVERITY_RANK } from "./severity.js";
import { AIContext, AIProvider, Confidence, CoverageDigest, CoverageEnhancement, Enhancement, FlowStatus, HistoricalIntelligenceDigest, HistoricalIntelligenceEnhancement, IntentScenario, IntelligenceDigest, IntelligenceEnhancement, Mode, QaFinding, RegressionDigest, RegressionEnhancement, Severity, TriageVerdict, UserFlow, VerificationResult } from "./types.js";

// ---------------------------------------------------------------------------
// Providers.
//
// DeterministicProvider is the default and never requires network access or an
// API key. OpenAICompatibleProvider enhances the deterministic draft through a
// single bounded JSON call per stage, funnelled through one `postJson` helper
// that retries transient statuses with backoff. Any failure still falls back to
// the deterministic result, but the reason is now recorded per stage and can be
// reported by the caller instead of failing silently.
//
// Secrets: the API key is used only in the Authorization header. It is never
// included in the prompt body, never logged, and never surfaced in reports.
// ---------------------------------------------------------------------------
const DEFAULT_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const CONFIDENCES: Confidence[] = ["high", "medium", "low"];
const PRIORITIES: Priority[] = ["P1", "P2", "P3", "P4"];
const FLOW_PRIORITIES: FlowPriority[] = ["P0", "P1", "P2", "P3", "P4"];
const FLOW_STATUSES: FlowStatus[] = ["identified", "blocked"];
const VERDICTS: TriageVerdict[] = ["LIKELY_DEFECT", "NOT_REPRODUCED", "CONDITIONAL", "INFRASTRUCTURE_PROBLEM", "REVIEW_REQUIRED"];

const CAPS = { recommendation: 400, userImpact: 300, rationale: 400, description: 400, title: 120, blockReason: 300, headline: 200, recommendationItem: 160 };

const asOptionalString = (value: unknown, cap: number): string | undefined =>
  typeof value === "string" ? value.trim().slice(0, cap) || undefined : undefined;

// ---------------------------------------------------------------------------
// Single HTTP entry point for every provider call.
//
// Previously each of the seven methods inlined its own fetch/parse/validate
// body and swallowed every failure with `catch { return null }`, so an expired
// key, a 429, and a 500 were indistinguishable and a broken key silently
// degraded every run to deterministic mode with no warning. This helper is the
// only place a network failure is handled: it retries transient statuses with
// backoff and records a concrete, non-secret reason that callers surface.
// ---------------------------------------------------------------------------

/** Why a provider call produced no enhancement. Safe to print: never contains the key. */
export type ProviderFailureReason =
  | "http-error"
  | "transport-error"
  | "timeout"
  | "malformed-response"
  | "schema-invalid"
  | "no-change";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class DeterministicProvider implements AIProvider {
  readonly name = "deterministic";
  readonly mode: Mode = "deterministic";
  readonly apiKeyPresent = false;
  async enhance(_context: AIContext): Promise<Enhancement | null> {
    return null;
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly mode: Mode = "ai-enhanced";
  readonly apiKeyPresent = true;
  readonly name: string;
  private readonly apiUrl: string;
  private readonly model: string;
  /**
   * The most recent failure reason per stage, so the CLI can warn that an
   * AI_API_KEY produced deterministic-only results instead of failing silently.
   * Keyed by stage name; values never contain credentials or response bodies.
   */
  private readonly failures = new Map<string, ProviderFailureReason>();

  constructor(
    private readonly apiKey: string,
    apiUrl?: string,
    model?: string,
  ) {
    const trimmedUrl = apiUrl?.trim();
    this.apiUrl = trimmedUrl && /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : DEFAULT_API_URL;
    this.model = model?.trim() || DEFAULT_MODEL;
    this.name = `${this.model} (openai-compatible)`;
  }

  /** Stages whose last call failed, for a single end-of-run diagnostic line. */
  failedStages(): string[] {
    return [...this.failures.entries()].filter(([, reason]) => reason !== "no-change").map(([stage]) => stage);
  }

  private noteFailure(stage: string, reason: ProviderFailureReason): null {
    this.failures.set(stage, reason);
    return null;
  }

  private noteSuccess(stage: string): void {
    this.failures.delete(stage);
  }

  /**
   * Issues one bounded chat-completion call and returns the parsed JSON body.
   * `parse` validates the payload; returning null from `parse` is a
   * `schema-invalid` no-op, not an error.
   */
  private async postJson<T>(stage: string, system: string, user: string, parse: (raw: unknown) => T | null): Promise<T | null> {
    const payload = { model: this.model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.apiUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        // A transport failure is worth one more attempt; a timeout is not
        // retried because a 60s budget per attempt would stall the whole run.
        if (!timedOut && attempt < MAX_ATTEMPTS) {
          await sleep(BASE_BACKOFF_MS * attempt);
          continue;
        }
        return this.noteFailure(stage, timedOut ? "timeout" : "transport-error");
      }

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BASE_BACKOFF_MS * attempt);
          continue;
        }
        return this.noteFailure(stage, "http-error");
      }

      let content: unknown;
      try {
        const json = await response.json() as { choices?: { message?: { content?: unknown } }[] };
        content = json.choices?.[0]?.message?.content;
      } catch {
        return this.noteFailure(stage, "malformed-response");
      }
      if (typeof content !== "string") return this.noteFailure(stage, "malformed-response");

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return this.noteFailure(stage, "malformed-response");
      }

      const value = parse(parsed);
      if (value === null) return this.noteFailure(stage, "schema-invalid");
      this.noteSuccess(stage);
      return value;
    }

    return this.noteFailure(stage, "transport-error");
  }

  async enhance(context: AIContext): Promise<Enhancement | null> {
    const system = [
      "You are a QA analysis assistant refining a deterministic website-qa report.",
      "Your job is ONLY to refine within strict bounds:",
      "- Reword recommendation, userImpact, or rationale of an existing finding to be more specific and actionable.",
      "- Adjust a finding's severity by at most one level up or down, and only with a strong evidence-based reason.",
      "- Reword a flow or intent scenario title/description without changing its meaning.",
      "- Adjust a scenario priority (P1-P4).",
      "- Provide a one-sentence headline and up to 5 top recommendations for the QA summary.",
      "You must NEVER invent evidence, DOM details, URLs, or test results not present in the provided data.",
      "Never add or remove findings, flows, or scenarios; their ids are fixed.",
      "Never mention, guess, or echo API keys, tokens, or environment secrets.",
      "Respond ONLY with a single JSON object matching the provided schema and nothing else.",
    ].join("\n");

    const user = [
      `Here is the deterministic draft for ${context.url} (title: "${context.title}").`,
      `Severity must stay within one level of the current value. Do not echo secrets.`,
      `Schema: {"findings":[{"findingId":"QA-F-001","severity":"HIGH","confidence":"high","recommendation":"string","userImpact":"string","rationale":"string"}],"flows":[{"flowId":"UF-SEARCH-001","title":"string","description":"string","status":"identified|blocked","blockReason":"string"}],"scenarios":[{"scenarioId":"SC-SEARCH-001","title":"string","description":"string","priority":"P1"}],"summary":{"headline":"string","topRecommendations":["string"]}}`,
      `Data: ${JSON.stringify({ findings: context.findings, flows: context.flows, scenarios: context.scenarios })}`,
    ].join("\n");

    return this.postJson("enhance", system, user, validateEnhancement);
  }

  async triageVerifications(results: VerificationResult[], context: { url: string; title: string }): Promise<VerificationResult[] | null> {
    const redactor = buildRedactor();
    const summaries = results.map(result => redactObject({
      findingId: result.findingId,
      scenarioId: result.scenarioId,
      strategy: result.strategy,
      status: result.status,
      category: result.category,
      locator: result.locator,
      expectation: result.expectation,
      error: result.error,
      evidence: {
        located: result.evidence.located,
        tag: result.evidence.tag,
        role: result.evidence.role,
        accessibleName: result.evidence.accessibleName,
        text: result.evidence.text,
        visible: result.evidence.visible,
        enabled: result.evidence.enabled,
        href: result.evidence.href,
        id: result.evidence.id,
        attributes: result.evidence.attributes,
        count: result.evidence.count,
      },
    }, redactor));

    const system = [
      "You are a QA triage assistant for website-finding verification.",
      "Each item describes one automated verification probe against a live page.",
      "REPRODUCED means the live DOM matched the suspected problem; NOT_REPRODUCED means it did not.",
      "Categories: LOCATOR = element absent, EXPECTATION = element found but clean, CONDITIONAL = hidden/state-dependent instance only.",
      "Classify each finding with exactly one of:",
      "- LIKELY_DEFECT when a reproduced suspicion is a genuine accessibility or quality problem.",
      "- NOT_REPRODUCED when the probe could not observe the problem.",
      "- CONDITIONAL when only a hidden or state-dependent instance exists.",
      "- INFRASTRUCTURE_PROBLEM only for runner, browser, network, or timeout failures.",
      "- REVIEW_REQUIRED when the evidence is insufficient to decide.",
      "Never invent DOM details. Never echo credentials, tokens, or API keys.",
      'Respond ONLY with JSON matching {"verdicts":[{"findingId":"...","verdict":"LIKELY_DEFECT","reason":"one sentence","confidence":"high"}],"":""}.',
    ].join("\n");

    const user = [
      `Site: ${context.url} (title: "${context.title}").`,
      `Data: ${JSON.stringify(summaries)}`,
    ].join("\n");

    const entries = await this.postJson("triage", system, user, validateTriageEntries);
    if (!entries?.length) return null;
    const triaged = results.map(result => {
      const entry = entries.find(item => item.findingId === result.findingId);
      if (!entry) return result;
      return {
        ...result,
        triage: { verdict: entry.verdict, reason: entry.reason, confidence: entry.confidence, provider: this.name },
      };
    });
    const changed = triaged.some((item, index) => item.triage !== results[index]?.triage);
    if (!changed) this.noteFailure("triage", "no-change");
    return changed ? triaged : null;
  }

  async analyzeFlows(flows: FlowDigest[], context: { url: string; title: string }): Promise<FlowAnalysisEnhancement[] | null> {
    const system = [
      "You are a QA assistant refining website user-flow discovery.",
      "Flows are derived deterministically from observed site structure. Evidence, step lists, safety, automation, and categories are fixed and may NOT change.",
      "You may ONLY:",
      "- Reword a flow title or description to be clearer, without changing its meaning.",
      "- Adjust priority to exactly one of P0, P1, P2, P3, P4.",
      "Never invent flows, pages, URLs, or site details. Never echo credentials, tokens, or API keys.",
      'Respond ONLY with JSON matching {"flows":[{"flowId":"FLOW-001","title":"string","description":"string","priority":"P2"}]} and nothing else.',
    ].join("\n");

    const user = [
      `Site: ${context.url} (title: "${context.title}").`,
      `Data: ${JSON.stringify(flows)}`,
    ].join("\n");

    return this.postJson("analyze-flows", system, user, validateFlowAnalysis);
  }

  async analyzeCoverage(digest: CoverageDigest, context: { url: string; title: string }): Promise<CoverageEnhancement | null> {
    const system = [
      "You are a QA coverage-planning assistant refining a deterministic test plan.",
      "Coverage items, statuses, counts, and evidence are FACTS and may not change.",
      "You may ONLY:",
      "- Reword the deterministic gap headlines (already computed from evidence) to be clearer.",
      "- Adjust the priority of an EXISTING recommendation, identified by recommendationId (REC-001 ...), to exactly one of P0, P1, P2, P3, P4.",
      "Never invent coverage items, statuses, evidence, pages, URLs, or flows. Never un-block or downgrade blocked/review-recommended work.",
      "Never echo credentials, tokens, or API keys.",
      'Respond ONLY with JSON matching {"gaps":["string"],"prioritization":[{"recommendationId":"REC-001","priority":"P1","reason":"one sentence"}]} and nothing else.',
    ].join("\n");

    const user = [
      `Site: ${context.url} (title: "${context.title}").`,
      `Data: ${JSON.stringify(digest)}`,
    ].join("\n");

    return this.postJson("coverage", system, user, validateCoverageEnhancement);
  }

  async analyzeRegression(digest: RegressionDigest, context: { url: string; title: string }): Promise<RegressionEnhancement | null> {
    const system = [
      "You are a QA regression-summary assistant working on a DETERMINISTIC two-run comparison.",
      "The comparison, classifications, confidence levels, references, and evidence are FACTS and may not change.",
      "You may ONLY:",
      "- Reword the existing summary headline to be clearer (never claim a regression or fix that is not already classified).",
      "- Attach a one-to-two sentence note to an EXISTING changeId (RG-0001 ...) explaining what to look at first.",
      "Never invent changes, regressions, fixes, previous results, or evidence. Never change a classification, confidence level, or recommendation, and never downgrade a REVIEW_REQUIRED or INFRASTRUCTURE_PROBLEM item.",
      "Never echo credentials, tokens, or API keys.",
      'Respond ONLY with JSON matching {"headline":"string","notes":[{"changeId":"RG-0001","note":"string"}]} and nothing else.',
    ].join("\n");

    const user = [
      `Site: ${context.url} (title: "${context.title}").`,
      `Data: ${JSON.stringify(digest)}`,
    ].join("\n");

    return this.postJson("regression", system, user, validateRegressionEnhancement);
  }

  async analyzeIntelligence(digest: IntelligenceDigest, context: { url: string; title: string }): Promise<IntelligenceEnhancement | null> {
    const system = [
      "You are a QA intelligence assistant working on a DETERMINISTIC root-cause analysis.",
      "The candidates, evidence, confidence levels, statuses, investigation actions, and coverage statuses are FACTS and may not change.",
      "You may ONLY:",
      "- Reword an EXISTING candidate title or description (candidateId, e.g. RC-0001) to be clearer, WITHOUT changing its meaning or adding claims.",
      "Never invent candidates, evidence, causes, URLs, or investigation actions. Never change confidence, status, or a safe/read-only action, and never downgrade an INSUFFICIENT_EVIDENCE or INFORMATIONAL item.",
      "A candidate is always a hypothesis, never a confirmed cause.",
      "Never echo credentials, tokens, or API keys.",
      'Respond ONLY with JSON matching {"wording":[{"candidateId":"RC-0001","title":"string","description":"string"}]} and nothing else.',
    ].join("\n");

    const user = [
      `Site: ${context.url} (title: "${context.title}").`,
      `Data: ${JSON.stringify(digest)}`,
    ].join("\n");

    return this.postJson("intelligence", system, user, validateIntelligenceEnhancement);
  }

  async analyzeHistoricalIntelligence(digest: HistoricalIntelligenceDigest, context: { url: string; title: string }): Promise<HistoricalIntelligenceEnhancement | null> {
    const system = [
      "You are a QA historical-intelligence assistant working on a DETERMINISTIC multi-run analysis.",
      "The classifications, run ids, confidence levels, investigation queue, and limitations are FACTS and may not change.",
      "You may ONLY:",
      "- Reword the deterministic summary headline to be more readable, WITHOUT changing any classified claim.",
      "Never invent patterns, fixes, regressions, future behavior, or new limitations, and never reorder or re-prioritize the queue.",
      "Never echo credentials, tokens, or API keys.",
      'Respond ONLY with JSON matching {"headline":"string"} and nothing else.',
    ].join("\n");

    const user = [
      `Site: ${context.url} (title: "${context.title}").`,
      `Data: ${JSON.stringify(digest)}`,
    ].join("\n");

    return this.postJson("historical-intelligence", system, user, validateHistoricalIntelligenceEnhancement);
  }
}

export function createAIProvider(env: NodeJS.ProcessEnv = process.env): AIProvider {
  const key = env.AI_API_KEY?.trim();
  if (key) return new OpenAICompatibleProvider(key, env.AI_API_URL?.trim(), env.AI_MODEL?.trim());
  return new DeterministicProvider();
}

// ---------------------------------------------------------------------------
// Flow analysis validation: only title/description/priority may be refined and
// every value is whitelisted — the model can never touch evidence, steps,
// safety, automation, or categories.
// ---------------------------------------------------------------------------
export function validateFlowAnalysis(raw: unknown): FlowAnalysisEnhancement[] | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const flows: FlowAnalysisEnhancement[] = [];
  if (Array.isArray(value.flows)) {
    for (const item of value.flows) {
      if (!item || typeof item !== "object" || typeof (item as { flowId?: unknown }).flowId !== "string") continue;
      const entry = item as Record<string, unknown>;
      const title = asOptionalString(entry.title, CAPS.title);
      const description = asOptionalString(entry.description, CAPS.description);
      const priority = typeof entry.priority === "string" && FLOW_PRIORITIES.includes(entry.priority as FlowPriority) ? (entry.priority as FlowPriority) : undefined;
      if (!title && !description && !priority) continue;
      flows.push({
        flowId: entry.flowId as string,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(priority ? { priority } : {}),
      });
    }
  }
  return flows.length ? flows : null;
}

// ---------------------------------------------------------------------------
// Triage validation: whitelists verdicts/confidence and drops invalid entries so
// a misbehaving model can only refine already-observed results — it can never
// invent verdicts, change statuses, or touch evidence.
// ---------------------------------------------------------------------------
export function validateTriageEntries(raw: unknown): { findingId: string; verdict: TriageVerdict; reason: string; confidence: Confidence }[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as { verdicts?: unknown };
  if (!Array.isArray(value.verdicts)) return [];
  const entries: { findingId: string; verdict: TriageVerdict; reason: string; confidence: Confidence }[] = [];
  for (const item of value.verdicts) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const findingId = typeof record.findingId === "string" && record.findingId.trim() ? record.findingId.trim().slice(0, 40) : null;
    const verdict = (VERDICTS as string[]).includes(record.verdict as string) ? record.verdict as TriageVerdict : null;
    const confidence = (CONFIDENCES as string[]).includes(record.confidence as string) ? record.confidence as Confidence : null;
    const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 300) : "";
    if (findingId && verdict && confidence && reason) entries.push({ findingId, verdict, reason, confidence });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Coverage enhancement validation: whitelists gap rewrites and priority changes
// on EXISTING recommendation ids. The model can never add items, change
// statuses, or invent evidence.
// ---------------------------------------------------------------------------
export function validateCoverageEnhancement(raw: unknown): CoverageEnhancement | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const gaps: string[] = [];
  if (Array.isArray(value.gaps)) {
    for (const item of value.gaps.slice(0, 8)) {
      const text = asOptionalString(item, 300);
      if (text && !gaps.includes(text)) gaps.push(text);
    }
  }

  const prioritization: CoverageEnhancement["prioritization"] = [];
  if (Array.isArray(value.prioritization)) {
    for (const item of value.prioritization.slice(0, 40)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const recommendationId = typeof entry.recommendationId === "string" && entry.recommendationId.trim() ? entry.recommendationId.trim().slice(0, 40) : null;
      const priority = typeof entry.priority === "string" && FLOW_PRIORITIES.includes(entry.priority as FlowPriority) ? (entry.priority as FlowPriority) : null;
      const reason = typeof entry.reason === "string" ? entry.reason.trim().slice(0, 280) : "";
      if (recommendationId && priority) prioritization.push({ recommendationId, priority, reason: reason || "Prioritized from coverage evidence." });
    }
  }

  if (!gaps.length && !prioritization.length) return null;
  return { ...(gaps.length ? { gaps } : {}), ...(prioritization.length ? { prioritization } : {}) };
}

// ---------------------------------------------------------------------------
// Regression summary validation: only a headline and notes for EXISTING change
// ids. A misbehaving model can never create changes or alter classifications.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Historical-intelligence summary validation: only a plain-language headline.
// A misbehaving model can never claim fixes/regressions or touch facts.
// ---------------------------------------------------------------------------
export function validateHistoricalIntelligenceEnhancement(raw: unknown): HistoricalIntelligenceEnhancement | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const headline = typeof value.headline === "string" ? value.headline.trim().slice(0, CAPS.headline) : "";
  return headline ? { headline } : null;
}

export function validateRegressionEnhancement(raw: unknown): RegressionEnhancement | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const headline = typeof value.headline === "string" ? value.headline.trim().slice(0, 300) : "";

  const notes: NonNullable<RegressionEnhancement["notes"]> = [];
  if (Array.isArray(value.notes)) {
    for (const item of value.notes.slice(0, 60)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const changeId = typeof entry.changeId === "string" && entry.changeId.trim() ? entry.changeId.trim().slice(0, 40) : null;
      const note = typeof entry.note === "string" ? entry.note.trim().slice(0, 500) : "";
      if (changeId && note) notes.push({ changeId, note });
    }
  }

  if (!headline && !notes.length) return null;
  return { ...(headline ? { headline } : {}), ...(notes.length ? { notes } : {}) };
}

// ---------------------------------------------------------------------------
// Enhancement validation: whitelists every type and drops invalid entries so a
// misbehaving model can never corrupt the deterministic baseline.
// ---------------------------------------------------------------------------
export function validateEnhancement(raw: unknown): Enhancement | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const findings: NonNullable<Enhancement["findings"]> = [];
  if (Array.isArray(value.findings)) {
    for (const item of value.findings) {
      if (!item || typeof item !== "object" || typeof (item as { findingId?: unknown }).findingId !== "string") continue;
      const entry = item as Record<string, unknown>;
      const severity = typeof entry.severity === "string" && SEVERITIES.includes(entry.severity as Severity) ? (entry.severity as Severity) : undefined;
      const confidence = typeof entry.confidence === "string" && CONFIDENCES.includes(entry.confidence as Confidence) ? (entry.confidence as Confidence) : undefined;
      // If a known enum field is present but invalid, drop the entire entry.
      if (entry.severity !== undefined && severity === undefined) continue;
      if (entry.confidence !== undefined && confidence === undefined) continue;
      if (!severity && !confidence && entry.recommendation === undefined && entry.userImpact === undefined && entry.rationale === undefined) continue;
      findings.push({
        findingId: entry.findingId as string,
        ...(severity ? { severity } : {}),
        ...(confidence ? { confidence } : {}),
        ...(asOptionalString(entry.recommendation, CAPS.recommendation) ? { recommendation: asOptionalString(entry.recommendation, CAPS.recommendation)! } : {}),
        ...(asOptionalString(entry.userImpact, CAPS.userImpact) ? { userImpact: asOptionalString(entry.userImpact, CAPS.userImpact)! } : {}),
        ...(asOptionalString(entry.rationale, CAPS.rationale) ? { rationale: asOptionalString(entry.rationale, CAPS.rationale)! } : {}),
      });
    }
  }

  const flows: NonNullable<Enhancement["flows"]> = [];
  if (Array.isArray(value.flows)) {
    for (const item of value.flows) {
      if (!item || typeof item !== "object" || typeof (item as { flowId?: unknown }).flowId !== "string") continue;
      const entry = item as Record<string, unknown>;
      const title = asOptionalString(entry.title, CAPS.title);
      const description = asOptionalString(entry.description, CAPS.description);
      const status = typeof entry.status === "string" && FLOW_STATUSES.includes(entry.status as FlowStatus) ? (entry.status as FlowStatus) : undefined;
      const blockReason = asOptionalString(entry.blockReason, CAPS.blockReason);
      if (!title && !description && !status && !blockReason) continue;
      flows.push({
        flowId: entry.flowId as string,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(status ? { status } : {}),
        ...(blockReason ? { blockReason } : {}),
      });
    }
  }

  const scenarios: NonNullable<Enhancement["scenarios"]> = [];
  if (Array.isArray(value.scenarios)) {
    for (const item of value.scenarios) {
      if (!item || typeof item !== "object" || typeof (item as { scenarioId?: unknown }).scenarioId !== "string") continue;
      const entry = item as Record<string, unknown>;
      const title = asOptionalString(entry.title, CAPS.title);
      const description = asOptionalString(entry.description, CAPS.description);
      const priority = typeof entry.priority === "string" && PRIORITIES.includes(entry.priority as Priority) ? (entry.priority as Priority) : undefined;
      if (!title && !description && !priority) continue;
      scenarios.push({
        scenarioId: entry.scenarioId as string,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(priority ? { priority } : {}),
      });
    }
  }

  let summary: Enhancement["summary"];
  if (value.summary && typeof value.summary === "object") {
    const summaryValue = value.summary as Record<string, unknown>;
    const headline = asOptionalString(summaryValue.headline, CAPS.headline);
    const topRecommendations: string[] = [];
    if (Array.isArray(summaryValue.topRecommendations)) {
      for (const item of summaryValue.topRecommendations.slice(0, 5)) {
        const text = asOptionalString(item, CAPS.recommendationItem);
        if (text && !topRecommendations.includes(text)) topRecommendations.push(text);
      }
    }
    if (headline || topRecommendations.length) summary = { ...(headline ? { headline } : {}), ...(topRecommendations.length ? { topRecommendations } : {}) };
  }

  if (!findings.length && !flows.length && !scenarios.length && !summary) return null;
  return { ...(findings.length ? { findings } : {}), ...(flows.length ? { flows } : {}), ...(scenarios.length ? { scenarios } : {}), ...(summary ? { summary } : {}) };
}

// ---------------------------------------------------------------------------
// Bounded application of an enhancement onto the deterministic baseline.
// ---------------------------------------------------------------------------
export type AnalysisParts = {
  findings: QaFinding[];
  flows: UserFlow[];
  scenarios: IntentScenario[];
};

export type ApplyResult = AnalysisParts & { headline?: string; topRecommendations?: string[] };

export function applyEnhancement(parts: AnalysisParts, enhancement: Enhancement | null): ApplyResult {
  if (!enhancement) return parts as ApplyResult;

  const findingById = new Map(parts.findings.map(finding => [finding.id, finding]));
  const flowById = new Map(parts.flows.map(flow => [flow.id, flow]));
  const scenarioById = new Map(parts.scenarios.map(scenario => [scenario.id, scenario]));

  for (const item of enhancement.findings ?? []) {
    const finding = findingById.get(item.findingId);
    if (!finding) continue;
    if (item.severity && Math.abs(SEVERITY_RANK[item.severity] - SEVERITY_RANK[finding.severity]) <= 1) finding.severity = item.severity;
    if (item.confidence && CONFIDENCES.includes(item.confidence)) finding.confidence = item.confidence;
    if (item.recommendation) finding.recommendation = item.recommendation;
    if (item.userImpact) finding.userImpact = item.userImpact;
    if (item.rationale) finding.rationale = item.rationale;
  }

  for (const item of enhancement.flows ?? []) {
    const flow = flowById.get(item.flowId);
    if (!flow) continue;
    if (item.title) flow.title = item.title;
    if (item.description) flow.description = item.description;
    if (item.status) flow.status = item.status;
    if (item.blockReason !== undefined) flow.blockReason = item.blockReason;
  }

  for (const item of enhancement.scenarios ?? []) {
    const scenario = scenarioById.get(item.scenarioId);
    if (!scenario) continue;
    if (item.title) scenario.title = item.title;
    if (item.description) scenario.description = item.description;
    if (item.priority && PRIORITIES.includes(item.priority)) scenario.priority = item.priority;
  }

  return {
    findings: parts.findings,
    flows: parts.flows,
    scenarios: parts.scenarios,
    headline: enhancement.summary?.headline,
    topRecommendations: enhancement.summary?.topRecommendations,
  };
}

export const isIntentCategory = (value: unknown): value is IntentCategory =>
  typeof value === "string" && ["NAVIGATION", "ACCESSIBILITY", "SEARCH", "AUTHENTICATION", "FORM", "MEDIA", "LANGUAGE", "PROFILE", "CONTENT", "VALIDATION", "RESPONSIVE", "ERROR_HANDLING"].includes(value);