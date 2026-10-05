import { Page } from "@playwright/test";
import { buildRedactor } from "../executor/redact.js";
import { locatorFromExpr } from "../executor/verify.js";
import { classifyFlowFailure, isExecutableStep } from "./classify.js";
import { DiscoveredFlow, FlowExecutionResult, FlowFailureCategory, FlowStep, FlowStepExecutionResult, FlowStepOutcome } from "./types.js";

// ---------------------------------------------------------------------------
// Safe flow executor.
//
// Only steps classified SAFE + AUTOMATED ever run. The executor executes the
// contiguous runnable prefix of a flow and STOPS at the first boundary step
// (REVIEW / HIGH_RISK / BLOCKED), recording that stop explicitly. Flows never
// fill credentials, submit arbitrary forms, or follow cross-origin links.
// Every step writes a partial FlowStepExecutionResult and the flow itself
// settles on one terminal outcome. Values are redacted before they are stored.
// ---------------------------------------------------------------------------

export type FlowRunOptions = {
  startTimeoutMs?: number;
  elementTimeoutMs?: number;
  limits?: { maxExecutionMs?: number };
};

let redact = buildRedactor(process.env);
export function refreshFlowRedactor(env: NodeJS.ProcessEnv = process.env): void {
  redact = buildRedactor(env);
}

const OUTCOME_RANK: Record<FlowStepOutcome, number> = {
  INFRASTRUCTURE_PROBLEM: 0,
  REPRODUCED: 1,
  REVIEW_REQUIRED: 2,
  NOT_REPRODUCED: 3,
  BLOCKED: 4,
  PASS: 5,
};

export function planFlowExecution(flow: DiscoveredFlow): { executable: FlowStep[]; boundaryAt: number | null } {
  const executable: FlowStep[] = [];
  let boundaryAt: number | null = null;
  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index]!;
    if (isExecutableStep(step)) {
      if (boundaryAt === null) executable.push(step);
    } else if (boundaryAt === null) {
      boundaryAt = index;
    }
  }
  return { executable, boundaryAt };
}

function stepResult(flow: DiscoveredFlow, scenarioId: string, stepIndex: number, step: FlowStep, outcome: FlowStepOutcome, category: FlowFailureCategory, reason: string, url: string | null, durationMs: number, error: FlowStepExecutionResult["error"]): FlowStepExecutionResult {
  return { flowId: flow.flowId, scenarioId, stepIndex, action: step.action, outcome, category, reason: redact(reason).slice(0, 500), locator: step.locator ?? null, url: url ? redact(url).slice(0, 1000) : null, durationMs, error };
}

async function runExecutableStep(page: Page, flow: DiscoveredFlow, scenarioId: string, stepIndex: number, step: FlowStep, options: FlowRunOptions): Promise<FlowStepExecutionResult> {
  const started = Date.now();
  const elementTimeout = options.elementTimeoutMs ?? 5000;
  let url: string | null = null;
  try {
    url = page.url();
    switch (step.action) {
      case "open": {
        if (!step.targetUrl) throw new Error("open step has no target URL");
        const response = await page.goto(step.targetUrl, { waitUntil: "domcontentloaded", timeout: options.startTimeoutMs ?? 30000 });
        const current = page.url();
        const status = response?.status();
        url = current;
        if (status !== undefined && status >= 400) {
          return stepResult(flow, scenarioId, stepIndex, step, "REPRODUCED", "WEBSITE", `Destination returned HTTP ${status} — the site's own link points at a failing page.`, url, Date.now() - started, null);
        }
        return stepResult(flow, scenarioId, stepIndex, step, "PASS", "WEBSITE", `Page loaded (HTTP ${status ?? "n/a"}).`, url, Date.now() - started, null);
      }
      case "observe":
      case "wait": {
        if (step.locator) {
          let count = 0;
          try {
            count = await locatorFromExpr(page, step.locator).count();
          } catch {
            count = 0;
          }
          if (count === 0) {
            return stepResult(flow, scenarioId, stepIndex, step, "NOT_REPRODUCED", "LOCATOR", "The expected element was not present on the page.", url, Date.now() - started, null);
          }
          return stepResult(flow, scenarioId, stepIndex, step, "PASS", "WEBSITE", `Expected element present (${count} match(es)).`, url, Date.now() - started, null);
        }
        const content = await page.evaluate(() => ({ title: (document.title ?? "").trim(), body: (document.body?.innerText ?? "").trim().length }));
        if (content.title || content.body > 0) {
          return stepResult(flow, scenarioId, stepIndex, step, "PASS", "WEBSITE", "The page rendered content.", url, Date.now() - started, null);
        }
        return stepResult(flow, scenarioId, stepIndex, step, "NOT_REPRODUCED", "WEBSITE", "The page appeared blank (no title and no body text).", url, Date.now() - started, null);
      }
      case "click-link":
      case "click": {
        if (!step.locator) throw new Error("click step has no locator");
        const count = await locatorFromExpr(page, step.locator).count();
        if (count === 0) {
          return stepResult(flow, scenarioId, stepIndex, step, "NOT_REPRODUCED", "LOCATOR", "The control the flow expected was not present.", url, Date.now() - started, null);
        }
        if (count > 1) {
          return stepResult(flow, scenarioId, stepIndex, step, "REVIEW_REQUIRED", "LOCATOR", `The control matched ${count} elements — ambiguous; not clicked.`, url, Date.now() - started, null);
        }
        await locatorFromExpr(page, step.locator).first().click({ timeout: elementTimeout });
        await safeLoadState(page);
        url = page.url();
        return stepResult(flow, scenarioId, stepIndex, step, "PASS", "WEBSITE", "The control was activated without error.", url, Date.now() - started, null);
      }
      case "type": {
        if (!step.locator) throw new Error("type step has no locator");
        const count = await locatorFromExpr(page, step.locator).count();
        if (count === 0) {
          return stepResult(flow, scenarioId, stepIndex, step, "NOT_REPRODUCED", "LOCATOR", "The field the flow expected was not present.", url, Date.now() - started, null);
        }
        await locatorFromExpr(page, step.locator).first().fill(step.text ?? "", { timeout: elementTimeout });
        return stepResult(flow, scenarioId, stepIndex, step, "PASS", "WEBSITE", "A synthetic, benign value was entered.", url, Date.now() - started, null);
      }
      case "submit": {
        if (step.locator) {
          const count = await locatorFromExpr(page, step.locator).count();
          if (count === 0) {
            return stepResult(flow, scenarioId, stepIndex, step, "NOT_REPRODUCED", "LOCATOR", "The submit control was not present.", url, Date.now() - started, null);
          }
          await locatorFromExpr(page, step.locator).first().click({ timeout: elementTimeout });
        } else {
          const searchInput = [...flow.steps].slice(0, stepIndex).reverse().find(previous => previous.action === "type" && previous.locator);
          if (!searchInput?.locator) throw new Error("submit step has no submit control and no prior input");
          await locatorFromExpr(page, searchInput.locator).first().press("Enter", { timeout: elementTimeout });
        }
        await safeLoadState(page);
        url = page.url();
        return stepResult(flow, scenarioId, stepIndex, step, "PASS", "WEBSITE", "The search/benign submit completed without error.", url, Date.now() - started, null);
      }
      default: {
        await safeLoadState(page);
        url = page.url();
        return stepResult(flow, scenarioId, stepIndex, step, "PASS", "WEBSITE", "Step completed.", url, Date.now() - started, null);
      }
    }
  } catch (caught) {
    const classified = classifyFlowFailure(caught);
    const result = stepResult(flow, scenarioId, stepIndex, step, classified.outcome, classified.category, classified.message, url ?? page.url(), Date.now() - started, { type: classified.type, message: redact(classified.message).slice(0, 1000) });
    return result;
  }
}

async function safeLoadState(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  } catch {
    // Navigation may be slow or aborted; the click outcome is already recorded.
  }
}

export async function runFlow(page: Page, flow: DiscoveredFlow, options: FlowRunOptions = {}): Promise<FlowExecutionResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const scenarioId = `SC-${flow.flowId}`;
  const startUrl = flow.startUrl;
  const stepResults: FlowStepExecutionResult[] = [];
  let finalUrl: string | null = null;
  let flowError: FlowExecutionResult["error"] = null;

  try {
    const response = await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: options.startTimeoutMs ?? 30000 });
    if (response && response.status() >= 400) {
      for (let index = 0; index < flow.steps.length; index++) {
        if (!isExecutableStep(flow.steps[index]!)) break;
        stepResults.push(stepResult(flow, scenarioId, index, flow.steps[index]!, "BLOCKED", "SAFETY_BLOCK", "Not run — the flow start page returned an HTTP error.", startUrl, 0, null));
      }
      return {
        scenarioId, flowId: flow.flowId, category: flow.category, title: flow.title, executedAt: startedAt,
        durationMs: Date.now() - started, status: "REPRODUCED", failureCategory: "WEBSITE", startedUrl: startUrl, finalUrl: startUrl,
        stoppedAtStep: null, boundary: null, steps: stepResults,
        error: { type: "START_HTTP_ERROR", message: `Flow start ${startUrl} returned HTTP ${response.status()}.` },
      };
    }
  } catch (caught) {
    const classified = classifyFlowFailure(caught);
    for (let index = 0; index < flow.steps.length; index++) {
      const step = flow.steps[index]!;
      if (!isExecutableStep(step)) {
        stepResults.push(stepResult(flow, scenarioId, index, step, "BLOCKED", "SAFETY_BLOCK", "Not run — the flow start page could not be reached.", startUrl, 0, null));
        break;
      }
    }
    return {
      scenarioId, flowId: flow.flowId, category: flow.category, title: flow.title, executedAt: startedAt,
      durationMs: Date.now() - started, status: classified.outcome, failureCategory: classified.category, startedUrl: startUrl, finalUrl: null,
      stoppedAtStep: null, boundary: null, steps: stepResults, error: { type: classified.type, message: redact(classified.message).slice(0, 1000) },
    };
  }

  finalUrl = page.url();
  const { boundaryAt } = planFlowExecution(flow);
  const limit = options.limits?.maxExecutionMs ?? 120000;

  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index]!;
    if (!isExecutableStep(step)) break;
    if (Date.now() - started > limit) {
      stepResults.push(stepResult(flow, scenarioId, index, step, "INFRASTRUCTURE_PROBLEM", "INFRASTRUCTURE", `Flow exceeded the ${limit}ms execution budget.`, page.url(), 0, { type: "TIME_BUDGET", message: "execution stopped at the time budget" }));
      flowError = { type: "TIME_BUDGET", message: "flow stopped at the execution time budget" };
      break;
    }
    const result = await runExecutableStep(page, flow, scenarioId, index, step, options);
    stepResults.push(result);
    finalUrl = result.url ?? finalUrl;
  }

  const executed = stepResults.filter(result => result.outcome !== "BLOCKED");
  const worst = executed.length ? executed.map(result => OUTCOME_RANK[result.outcome]).reduce((a, b) => Math.min(a, b)) : null;
  const boundary = boundaryAt !== null ? flow.steps[boundaryAt] : null;

  let status: FlowStepOutcome;
  let failureCategory: FlowFailureCategory | null;
  if (worst === null) {
    status = "BLOCKED";
    failureCategory = "SAFETY_BLOCK";
  } else {
    const worstResult = executed.find(item => OUTCOME_RANK[item.outcome] === worst) ?? null;
    if (worst === OUTCOME_RANK.INFRASTRUCTURE_PROBLEM) {
      status = "INFRASTRUCTURE_PROBLEM";
      failureCategory = worstResult?.category ?? "INFRASTRUCTURE";
      flowError = worstResult?.error ?? null;
    } else if (worst === OUTCOME_RANK.REPRODUCED) {
      status = "REPRODUCED";
      failureCategory = worstResult?.category ?? "WEBSITE";
    } else if (worst === OUTCOME_RANK.REVIEW_REQUIRED) {
      status = "REVIEW_REQUIRED";
      failureCategory = worstResult?.category ?? "REVIEW";
    } else if (worst === OUTCOME_RANK.NOT_REPRODUCED) {
      status = "NOT_REPRODUCED";
      failureCategory = worstResult?.category ?? "LOCATOR";
    } else if (boundary !== null) {
      status = "BLOCKED";
      failureCategory = "SAFETY_BLOCK";
    } else {
      status = "PASS";
      failureCategory = "WEBSITE";
    }
  }

  if (boundaryAt !== null && boundary !== null) {
    const boundaryStepIndex = stepResults.findIndex(item => item.stepIndex === boundaryAt);
    if (boundaryStepIndex === -1) {
      stepResults.push(stepResult(flow, scenarioId, boundaryAt, boundary, "BLOCKED", "SAFETY_BLOCK", boundary.reason, page.url(), 0, null));
    }
  }

  const overallBoundaryReason = boundary ? `Stopped safely before the ${boundary.safety}/${boundary.automation} step "${boundary.action}" — ${boundary.reason}` : null;
  return {
    scenarioId,
    flowId: flow.flowId,
    category: flow.category,
    title: flow.title,
    executedAt: startedAt,
    durationMs: Date.now() - started,
    status,
    failureCategory,
    startedUrl: startUrl,
    finalUrl,
    stoppedAtStep: boundaryAt,
    boundary: overallBoundaryReason ? redact(overallBoundaryReason).slice(0, 500) : null,
    steps: stepResults.sort((a, b) => a.stepIndex - b.stepIndex),
    error: flowError,
  };
}