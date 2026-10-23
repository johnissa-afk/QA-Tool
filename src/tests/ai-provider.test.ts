import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { analyzeScan } from "../ai/index.js";
import { applyEnhancement, createAIProvider, DeterministicProvider, OpenAICompatibleProvider, validateEnhancement, validateTriageEntries } from "../ai/provider.js";
import { buildFindings } from "../ai/analysis.js";
import { decorateScenarios } from "../ai/scenarios.js";
import { Confidence, QaFinding, Severity, VerificationResult } from "../ai/types.js";
import { generateTestSuite } from "../test-generator.js";
import { DiscoveredElement, ScanReport } from "../types.js";

const finding = (severity: Severity, confidence: Confidence = "high"): QaFinding => ({
  id: "QA-F-001",
  code: "image-missing-alt",
  status: "WARNING",
  lifecycle: "ANALYZED",
  relatedScenarioIds: [],
  verification: null,
  domain: "accessibility",
  severity,
  confidence,
  title: "Image missing alt",
  description: "x",
  recommendation: "r",
  userImpact: "u",
  rationale: "r",
  count: 1,
  evidence: [],
  examples: [],
});

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const report = (elements: DiscoveredElement[]): ScanReport => ({
  scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
  summary: { totalElements: elements.length, interactiveElements: elements.length, passes: 0, warnings: 1, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 2, groupedIssueCounts: { passes: 0, warnings: 1, failures: 0, infos: 0 } },
  page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements,
  issues: [{
    status: "FAIL" as const,
    code: "page-http-error",
    message: "Page navigation returned HTTP 500.",
    examples: [{ detail: "500" }],
  }],
  links: [], consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
});

/** Wraps a payload in a well-formed chat-completion envelope. */
function okCompletion(content: unknown) {
  return { status: 200, json: { choices: [{ message: { content: JSON.stringify(content) } }] } };
}

function startServer(handler: (url: string, body: string) => { status: number; json: unknown; headers?: Record<string, string> }) {
  let captured = "";
  let hits = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      captured = Buffer.concat(chunks).toString("utf8");
      hits += 1;
      const { status, json, headers } = handler(request.url ?? "/", captured);
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(json));
    });
  });
  return new Promise<{ port: number; captured: () => string; hits: () => number; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve({
        port: address.port,
        captured: () => captured,
        hits: () => hits,
        close: () => new Promise((res, rej) => server.close(error => error ? rej(error) : res())),
      });
    });
  });
}

test("no API key produces a deterministic, offline provider", () => {
  const provider = createAIProvider({});
  assert.ok(provider instanceof DeterministicProvider);
  assert.equal(provider.mode, "deterministic");
  assert.equal(provider.apiKeyPresent, false);
  assert.equal(provider.name, "deterministic");
});

test("an API key produces an ai-enhanced provider that never embeds the key", () => {
  const provider = createAIProvider({ AI_API_KEY: "sk-SECRET-ABC" });
  assert.ok(provider instanceof OpenAICompatibleProvider);
  assert.equal(provider.mode, "ai-enhanced");
  assert.equal(provider.apiKeyPresent, true);
  assert.ok(!provider.name.includes("SECRET"));
  assert.equal(provider.name.includes("gpt-4o-mini"), true);
});

test("deterministic provider returns no enhancement", async () => {
  assert.equal(await new DeterministicProvider().enhance({
    url: "https://qa.test", title: "x", mode: "deterministic", findings: [], flows: [], scenarios: [],
  }), null);
});

test("ai provider falls back silently on HTTP errors", async () => {
  const server = await startServer(() => ({ status: 500, json: { error: "boom" } }));
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    assert.equal(await provider.enhance({ url: "https://qa.test", title: "x", mode: "deterministic", findings: [], flows: [], scenarios: [] }), null);
  } finally {
    await server.close();
  }
});

test("ai provider reports a concrete stage instead of failing silently", async () => {
  const server = await startServer(() => ({ status: 401, json: { error: { message: "invalid api key" } } }));
  try {
    const provider = new OpenAICompatibleProvider("sk-EXPIRED", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    assert.deepEqual(provider.failedStages(), [], "a healthy provider reports no failed stages");
    assert.equal(await provider.enhance({ url: "https://qa.test", title: "x", mode: "deterministic", findings: [], flows: [], scenarios: [] }), null);
    assert.deepEqual(provider.failedStages(), ["enhance"], "the degraded stage is named so the CLI can warn");
  } finally {
    await server.close();
  }
});

test("ai provider retries a transient 503 and succeeds without a spurious failure", async () => {
  let call = 0;
  const server = await startServer(() => {
    call += 1;
    return call < 3
      ? { status: 503, json: { error: "overloaded" } }
      : okCompletion({ summary: { headline: "Recovered after retry." } });
  });
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    const enhancement = await provider.enhance({ url: "https://qa.test", title: "x", mode: "deterministic", findings: [], flows: [], scenarios: [] });
    assert.equal(server.hits(), 3, "the two transient failures are retried");
    assert.equal(enhancement?.summary?.headline, "Recovered after retry.");
    assert.deepEqual(provider.failedStages(), [], "a recovered stage is not reported as degraded");
  } finally {
    await server.close();
  }
});

test("ai provider does not retry a permanent 401", async () => {
  const server = await startServer(() => ({ status: 401, json: { error: "unauthorized" } }));
  try {
    const provider = new OpenAICompatibleProvider("sk-BAD", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    assert.equal(await provider.enhance({ url: "https://qa.test", title: "x", mode: "deterministic", findings: [], flows: [], scenarios: [] }), null);
    assert.equal(server.hits(), 1, "an auth failure is not retried");
    assert.deepEqual(provider.failedStages(), ["enhance"]);
  } finally {
    await server.close();
  }
});

test("ai provider surfaces a transport error when the host is unreachable", async () => {
  const provider = new OpenAICompatibleProvider("sk-TEST", "http://127.0.0.1:1/v1/chat/completions", "test-model");
  assert.equal(await provider.enhance({ url: "https://qa.test", title: "x", mode: "deterministic", findings: [], flows: [], scenarios: [] }), null);
  assert.deepEqual(provider.failedStages(), ["enhance"]);
});

test("ai provider marks a schema-rejected response as degraded, not as success", async () => {
  const server = await startServer(() => ({
    status: 200,
    json: { choices: [{ message: { content: JSON.stringify({ findings: [{ findingId: "QA-F-001", severity: "NOT_A_SEVERITY" }] }) } }] },
  }));
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    assert.equal(await provider.enhance({ url: "https://qa.test", title: "x", mode: "deterministic", findings: [], flows: [], scenarios: [] }), null);
    assert.deepEqual(provider.failedStages(), ["enhance"]);
  } finally {
    await server.close();
  }
});

test("ai provider clears a previously failed stage once a later call succeeds", async () => {
  let call = 0;
  const server = await startServer(() => {
    call += 1;
    return call === 1
      ? { status: 401, json: { error: "unauthorized" } }
      : okCompletion({ summary: { headline: "Second call is healthy." } });
  });
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    const context = { url: "https://qa.test", title: "x", mode: "deterministic" as const, findings: [], flows: [], scenarios: [] };
    await provider.enhance(context);
    assert.deepEqual(provider.failedStages(), ["enhance"]);
    await provider.enhance(context);
    assert.deepEqual(provider.failedStages(), [], "a success clears the stale failure");
  } finally {
    await server.close();
  }
});

test("ai provider falls back silently on malformed JSON content", async () => {
  const server = await startServer(() => ({ status: 200, json: { choices: [{ message: { content: "not json" } }] } }));
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    assert.equal(await provider.enhance({ url: "https://qa.test", title: "x", mode: "deterministic", findings: [], flows: [], scenarios: [] }), null);
  } finally {
    await server.close();
  }
});

test("ai provider round-trip: bounded enhancements apply, key stays out of the request body", async () => {
  const key = "sk-TOP-SECRET-xyz";
  let captured = "";
  const server = await startServer((_url, body) => {
    captured = body;
    return {
      status: 200,
      json: {
        choices: [{
          message: {
            content: JSON.stringify({
              findings: [{ findingId: "QA-F-001", severity: "HIGH", recommendation: "Reduce payload size and add retry logic." }],
              flows: [{ flowId: "UF-SEARCH-001", title: "Search the catalogue" }],
              scenarios: [{ scenarioId: "SC-SEARCH-001", priority: "P1" }],
              summary: { headline: "AI-enhanced: resolve the 500s before release.", topRecommendations: ["Fix the 500 first", "Then sweep labels"] },
            }),
          },
        }],
      },
    };
  });
  try {
    const reportResult = report([element({ accessibleName: "Search", role: "searchbox", tag: "input", type: "search", name: "q", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })" })]);
    const provider = new OpenAICompatibleProvider(key, `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    const analysis = await analyzeScan(reportResult, { suite: generateTestSuite(reportResult), provider });

    assert.equal(analysis.mode, "ai-enhanced");
    assert.equal(analysis.aiProvider, "test-model (openai-compatible)");
    assert.equal(analysis.summary.headline, "AI-enhanced: resolve the 500s before release.");
    assert.deepEqual(analysis.summary.topRecommendations, ["Fix the 500 first", "Then sweep labels"]);
    assert.equal(analysis.findings.find(finding => finding.id === "QA-F-001")?.recommendation, "Reduce payload size and add retry logic.");
    assert.equal(analysis.flows.find(flow => flow.id === "UF-SEARCH-001")?.title, "Search the catalogue");
    assert.equal(analysis.scenarios.find(scenario => scenario.id === "SC-SEARCH-001")?.priority, "P1");

    assert.ok(!captured.includes(key), "API key must never appear in the request body");
    assert.ok(captured.includes("test-model"), "request body must carry the model");
    assert.ok(JSON.stringify(analysis).includes("test-model (openai-compatible)"));
  } finally {
    await server.close();
  }
});

test("severity enhancement respects the one-level adjacency bound", () => {
  const apply = (suggested: Severity) => applyEnhancement(
    { findings: [finding("HIGH")], flows: [], scenarios: [] },
    { findings: [{ findingId: "QA-F-001", severity: suggested }] },
  );
  assert.equal(apply("CRITICAL").findings[0]?.severity, "CRITICAL", "HIGH -> CRITICAL (adjacent) allowed");
  assert.equal(apply("MEDIUM").findings[0]?.severity, "MEDIUM", "HIGH -> MEDIUM (adjacent) allowed");
  assert.equal(apply("INFO").findings[0]?.severity, "HIGH", "HIGH -> INFO (skipping three levels) rejected");
  assert.equal(apply("LOW").findings[0]?.severity, "HIGH", "HIGH -> LOW (two levels) rejected");
});

test("validateEnhancement whitelists enums and drops invalid or oversized entries", () => {
  const valid = validateEnhancement({
    findings: [{ findingId: "QA-F-001", severity: "MEDIUM", confidence: "low", recommendation: "ok" }],
    flows: [{ flowId: "UF-SEARCH-001", status: "blocked", title: "ok" }],
    scenarios: [{ scenarioId: "SC-X", priority: "P2" }],
    summary: { headline: "h", topRecommendations: ["a", "b"] },
  });
  assert.equal(valid?.findings?.length, 1);
  assert.equal(valid?.flows?.length, 1);
  assert.equal(valid?.summary?.topRecommendations?.length, 2);

  const bad = validateEnhancement({
    findings: [{ findingId: "QA-F-001", severity: "URGENT-CRITICAL-MAX", recommendation: "x".repeat(10_000) }],
    flows: [{ flowId: "UF-X", status: "maybe" }],
    scenarios: [{ scenarioId: "SC-X", priority: "P9" }],
    summary: { headline: "", topRecommendations: ["a", "b", "c", "d", "e", "f"] },
  });
  assert.equal(bad?.findings ?? null, null, "invalid severity + oversized string must be dropped");

  assert.equal(validateEnhancement("garbage"), null);
  assert.equal(validateEnhancement(12), null);
  assert.equal(validateEnhancement({}), null);
});

test("applyEnhancement ignores unknown ids and never adds scenarios", () => {
  const base = { findings: [finding("HIGH")], flows: [], scenarios: [] };
  const result = applyEnhancement(base, {
    findings: [{ findingId: "QA-F-999", severity: "CRITICAL", recommendation: "nope" }],
    flows: [{ flowId: "UF-NOPE-001", title: "invented" }],
    scenarios: [{ scenarioId: "SC-INVENTED-001", priority: "P1", title: "invented" }],
    summary: { headline: "h" },
  });
  assert.equal(result.findings[0]?.severity, "HIGH", "unknown-finding enhancement is ignored");
  assert.equal(result.findings[0]?.recommendation, "r");
  assert.equal(result.scenarios.length, 0, "the AI may never invent scenarios");
  assert.equal(result.headline, "h");
});

test("analyzeScan with determinism never depends on the network", async () => {
  const reportResult = report([element()]);
  const analysis = await analyzeScan(reportResult, { suite: generateTestSuite(reportResult) });
  assert.equal(analysis.mode, "deterministic");
  assert.equal(analysis.summary.overallStatus, "NOT_TESTED", "no verification run performed");
  assert.equal(analysis.summary.bySeverity.CRITICAL, 1);
  assert.ok(buildFindings(reportResult).length > 0);
  assert.ok(decorateScenarios(generateTestSuite(reportResult)).length > 0);
});

const verificationResult = (): VerificationResult => ({
  findingId: "QA-F-004",
  scenarioId: "SC-VER-001",
  strategy: "accessible-name",
  locator: "page.getByPlaceholder(\"Search\")",
  status: "REPRODUCED",
  category: "WEBSITE",
  executedAt: new Date().toISOString(),
  durationMs: 42,
  expectation: "Form control should have an accessible label.",
  evidence: {
    located: true,
    locator: "page.getByPlaceholder(\"Search\")",
    tag: "input",
    role: "searchbox",
    accessibleName: null,
    text: "password=superSecretToken",
    visible: true,
    enabled: true,
    href: null,
    url: null,
    id: "searchTerm",
    attributes: { placeholder: "Search" },
    count: 1,
    screenshotPath: null,
  },
  error: null,
  triage: null,
});

test("ai triage refines verdicts but never touches status or evidence, and scrubs secrets", async () => {
  const key = "sk-TRIA-GE-SECRET";
  let captured = "";
  const server = await startServer((_url, body) => {
    captured = body;
    return {
      status: 200,
      json: {
        choices: [{
          message: {
            content: JSON.stringify({
              verdicts: [{ findingId: "QA-F-004", verdict: "LIKELY_DEFECT", reason: "Unlabeled search field is a real defect.", confidence: "high" }],
            }),
          },
        }],
      },
    };
  });
  try {
    const provider = new OpenAICompatibleProvider(key, `http://127.0.0.1:${server.port}/v1/chat/completions`, "triage-model");
    const results = await provider.triageVerifications([verificationResult()], { url: "https://qa.test/en", title: "QA target" });
    assert.ok(results, "a clean response must not fall back to deterministic");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.triage?.verdict, "LIKELY_DEFECT");
    assert.equal(results[0]?.triage?.provider, "triage-model (openai-compatible)");
    assert.equal(results[0]?.status, "REPRODUCED", "status must never change during triage");
    assert.equal(results[0]?.evidence.count, 1, "evidence must never change during triage");
    assert.ok(!captured.includes(key), "API key must never appear in the triage request body");
    assert.ok(!captured.includes("superSecretToken"), "input secrets must be redacted before the triage request");
  } finally {
    await server.close();
  }
});

test("triage validates strictly and falls back to deterministic on malformed output", async () => {
  const valid = validateTriageEntries({ verdicts: [
    { findingId: "QA-F-001", verdict: "CONDITIONAL", reason: "hidden popup", confidence: "medium" },
    { findingId: "QA-F-002", verdict: "MAYBE_BROKEN", reason: "bad", confidence: "high" },
    { findingId: "QA-F-003", verdict: "LIKELY_DEFECT", reason: "ok", confidence: "certain" },
    { findingId: "", verdict: "LIKELY_DEFECT", reason: "x", confidence: "high" },
  ]});
  assert.equal(valid.length, 1, "only whitelisted verdicts/confidences survive");
  assert.equal(valid[0]?.verdict, "CONDITIONAL");
  assert.equal(validateTriageEntries("garbage").length, 0);
  assert.equal(validateTriageEntries(null).length, 0);
  assert.equal(validateTriageEntries({ verdicts: "nope" }).length, 0);

  const server = await startServer(() => ({ status: 200, json: { choices: [{ message: { content: "not json" } }] } }));
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${server.port}/v1/chat/completions`, "triage-model");
    assert.equal(await provider.triageVerifications([verificationResult()], { url: "https://qa.test/en", title: "QA target" }), null);
  } finally {
    await server.close();
  }
});

test("a valid response with nothing to refine is not reported as a degraded stage", async () => {
  const context = { url: "https://qa.test", title: "x", mode: "deterministic" as const, findings: [], flows: [], scenarios: [] };
  for (const content of [{ findings: [], flows: [], scenarios: [] }, {}]) {
    const server = await startServer(() => okCompletion(content));
    try {
      const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
      const out = await provider.enhance(context);
      assert.equal(out, null);
      assert.deepEqual(provider.failedStages(), [], `no-op ${JSON.stringify(content)} is not a failure`);
      assert.deepEqual(provider.failedStageDetails(), []);
    } finally {
      await server.close();
    }
  }
});

test("malformed triage output is a schema failure; an empty verdict list is not", async () => {
  const malformed = await startServer(() => okCompletion({ verdicts: "nope" }));
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${malformed.port}/v1/chat/completions`, "triage-model");
    assert.equal(await provider.triageVerifications([verificationResult()], { url: "https://qa.test/en", title: "QA target" }), null);
    assert.deepEqual(provider.failedStageDetails(), [{ stage: "triage", reason: "schema-invalid" }]);
  } finally {
    await malformed.close();
  }

  const empty = await startServer(() => okCompletion({ verdicts: [] }));
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${empty.port}/v1/chat/completions`, "triage-model");
    assert.equal(await provider.triageVerifications([verificationResult()], { url: "https://qa.test/en", title: "QA target" }), null);
    assert.deepEqual(provider.failedStages(), [], "an empty verdict list means the deterministic verdicts stand");
  } finally {
    await empty.close();
  }
});

test("enhance redacts scanner text before sending the deterministic draft", async () => {
  const captured: string[] = [];
  const server = await startServer((_url, body) => {
    captured.push(body);
    return okCompletion({ summary: { headline: "ok" } });
  });
  try {
    const provider = new OpenAICompatibleProvider("sk-TEST", `http://127.0.0.1:${server.port}/v1/chat/completions`, "test-model");
    await provider.enhance({
      url: "https://qa.test",
      title: "x",
      mode: "deterministic",
      findings: [{ id: "QA-F-001", code: "x", severity: "HIGH", confidence: "high", count: 1, message: "password=hunter2-secret" }],
      flows: [],
      scenarios: [],
    });
    assert.ok(!captured.join("\n").includes("hunter2-secret"), "credentials in scanner text are redacted before the AI call");
  } finally {
    await server.close();
  }
});