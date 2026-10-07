// ---------------------------------------------------------------------------
// Phase 8E — QA configuration.
//
// A thin, optional local JSON layer (`qa.config.json` at the project root) over
// the EXISTING QA pipeline. It controls existing behavior only: it never
// implements a second pipeline, a second CI policy engine, or a second
// dashboard configuration system. The precedence is always:
//
//     built-in defaults  <  qa.config.json  <  CLI arguments
//
// This module is deliberately independent from every QA stage. It locates,
// loads, parses, validates, and resolves the configuration; the CLI
// (`src/qa-cli.ts`) is the only place that merges it with CLI arguments and
// applies it to the pipeline. No crawling, execution, coverage, regression,
// root-cause, or history logic lives here.
//
// Discovery is intentionally simple (spec §12): exactly `qa.config.json` in the
// project root. No global/inherited/workspace/remote/YAML/JS/TS configuration.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseBaselineMaxAge } from "./baseline.js";
import { CI_FAIL_POLICIES, CiFailPolicy } from "./ci-policy.js";
import { GATE_DEFAULT_MIN_SEVERITY, GATE_MIN_SEVERITIES, GateMinSeverity } from "./gate.js";

/** The single supported configuration filename, discovered at the project root. */
export const QA_CONFIG_FILENAME = "qa.config.json";

/** A stage that already exists in the pipeline and can be safely turned on/off. */
export type QaStageConfig = { enabled?: boolean };

/**
 * Typed configuration contract. Every field is optional; an absent property
 * means "keep the existing built-in default". Property names follow the
 * existing option/argument names where one exists (`crawl.maxPages` → the
 * `--max-pages` budget; `ci.failOn` → the Phase 8C `--fail-on` policy).
 */
export type QaConfig = {
  crawl?: { maxPages?: number };
  execution?: QaStageConfig;
  coverage?: QaStageConfig;
  regression?: QaStageConfig;
  rootCause?: QaStageConfig;
  history?: QaStageConfig;
  historicalIntelligence?: QaStageConfig;
  ci?: { failOn?: CiFailPolicy; gateMinSeverity?: GateMinSeverity };
  /**
   * Phase 10D — baseline rotation policy (`--baseline-max-age`).
   * Phase 11 — baseline pinning: the default regression comparison target
   * (`--baseline`), so the gate and rotation re-use the same artifact without
   * repeating the flag on every invocation. Relative to the working directory.
   */
  baseline?: { maxAge?: string; path?: string };
  /**
   * Phase 13 — performance budgets: path to the JSON budget file, the same
   * file `--perf-budgets` takes (so CI can pin budgets once instead of editing
   * the workflow). Relative to the working directory. The CLI flag wins.
   */
  perf?: { budgets?: string };
};

/** Result of locating + loading the configuration file. */
export type LoadedQaConfig = {
  /** Absolute path of the loaded `qa.config.json`, or null when defaults apply. */
  source: string | null;
  /** Human-readable source label for the CLI/artifact ("defaults" when absent). */
  sourceLabel: string;
  config: QaConfig;
};

/** Built-in defaults applied AFTER the config file and BEFORE CLI arguments. */
export type ResolvedQaConfig = {
  maxPages: number;
  execution: boolean;
  coverage: boolean;
  regression: boolean;
  rootCause: boolean;
  history: boolean;
  historicalIntelligence: boolean;
  failOn: CiFailPolicy | null;
  /** Phase 9: minimum severity for NEW findings that fail the baseline gate. */
  gateMinSeverity: GateMinSeverity;
  /** Phase 10D: baseline rotation policy as a duration string, or null. */
  baselineMaxAge: string | null;
  /** Phase 11: default baseline artifact path (`--baseline`), or null. */
  baselinePath: string | null;
  /** Phase 13: performance budgets file (`--perf-budgets`), or null. */
  perfBudgetsPath: string | null;
};

export const QA_CONFIG_DEFAULTS: ResolvedQaConfig = {
  maxPages: 8,
  execution: false,
  coverage: true,
  regression: true,
  rootCause: true,
  history: true,
  historicalIntelligence: true,
  failOn: null,
  gateMinSeverity: GATE_DEFAULT_MIN_SEVERITY,
  baselineMaxAge: null,
  baselinePath: null,
  perfBudgetsPath: null,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A configuration problem always names the file and the offending property. */
function configError(source: string, detail: string): never {
  throw new Error(`Invalid ${basename(source)}: ${detail}`);
}

function assertOnlyKeys(source: string, value: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const supported = allowed.map(entry => `${prefix}${entry}`).join(", ");
      configError(source, `unknown property "${prefix}${key}" — supported: ${supported}.`);
    }
  }
}

const STAGE_SECTIONS = ["execution", "coverage", "regression", "rootCause", "history", "historicalIntelligence"] as const;

function parseStage(source: string, section: string, raw: unknown): QaStageConfig {
  if (!isPlainObject(raw)) configError(source, `"${section}" must be an object (e.g. { "enabled": true }).`);
  assertOnlyKeys(source, raw, ["enabled"], `${section}.`);
  if (raw.enabled === undefined) return {};
  if (typeof raw.enabled !== "boolean") configError(source, `"${section}.enabled" must be a boolean.`);
  return { enabled: raw.enabled };
}

/**
 * Validates a parsed JSON value against the supported schema. Unknown
 * properties are a hard error (spec §10) so a typo like `covergae` can never
 * silently do nothing.
 */
export function parseQaConfig(raw: unknown, source: string): QaConfig {
  if (!isPlainObject(raw)) configError(source, "the configuration must be a JSON object.");
  assertOnlyKeys(source, raw, ["crawl", ...STAGE_SECTIONS, "ci", "baseline", "perf"], "");

  const config: QaConfig = {};

  if (raw.crawl !== undefined) {
    if (!isPlainObject(raw.crawl)) configError(source, `"crawl" must be an object (e.g. { "maxPages": 100 }).`);
    assertOnlyKeys(source, raw.crawl, ["maxPages"], "crawl.");
    if (raw.crawl.maxPages !== undefined) {
      const value = raw.crawl.maxPages;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        configError(source, `"crawl.maxPages" must be an integer >= 1 (received ${JSON.stringify(value)}).`);
      }
      config.crawl = { maxPages: value };
    } else {
      config.crawl = {};
    }
  }

  for (const section of STAGE_SECTIONS) {
    if (raw[section] !== undefined) config[section] = parseStage(source, section, raw[section]);
  }

  if (raw.ci !== undefined) {
    if (!isPlainObject(raw.ci)) configError(source, `"ci" must be an object (e.g. { "failOn": "failed" }).`);
    assertOnlyKeys(source, raw.ci, ["failOn", "gateMinSeverity"], "ci.");
    let failOn: CiFailPolicy | undefined;
    if (raw.ci.failOn !== undefined) {
      const value = raw.ci.failOn;
      if (typeof value !== "string" || !CI_FAIL_POLICIES.includes(value.toLowerCase() as CiFailPolicy)) {
        configError(source, `"ci.failOn" must be one of ${CI_FAIL_POLICIES.join(" | ")} (received ${JSON.stringify(value)}).`);
      }
      failOn = value.toLowerCase() as CiFailPolicy;
    }
    let gateMinSeverity: GateMinSeverity | undefined;
    if (raw.ci.gateMinSeverity !== undefined) {
      const value = raw.ci.gateMinSeverity;
      const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
      if (!GATE_MIN_SEVERITIES.includes(normalized as GateMinSeverity)) {
        configError(source, `"ci.gateMinSeverity" must be one of ${GATE_MIN_SEVERITIES.join(" | ")} (received ${JSON.stringify(value)}).`);
      }
      gateMinSeverity = normalized as GateMinSeverity;
    }
    config.ci = { ...(failOn !== undefined ? { failOn } : {}), ...(gateMinSeverity !== undefined ? { gateMinSeverity } : {}) };
    if (Object.keys(config.ci).length === 0) config.ci = {};
  }

  if (raw.baseline !== undefined) {
    if (!isPlainObject(raw.baseline)) configError(source, `"baseline" must be an object (e.g. { "maxAge": "30d" }).`);
    assertOnlyKeys(source, raw.baseline, ["maxAge", "path"], "baseline.");
    if (raw.baseline.maxAge !== undefined) {
      const value = raw.baseline.maxAge;
      if (typeof value !== "string" || value.trim() === "") {
        configError(source, `"baseline.maxAge" must be a duration string like "30d" or "12h".`);
      }
      try {
        parseBaselineMaxAge(value);
      } catch {
        configError(source, `"baseline.maxAge" must be <number>m|h|d|w (e.g. "30d", "12h", "90m") (received ${JSON.stringify(value)}).`);
      }
      config.baseline = { maxAge: value.trim().toLowerCase() };
    }
    if (raw.baseline.path !== undefined) {
      const value = raw.baseline.path;
      if (typeof value !== "string" || value.trim() === "") {
        configError(source, `"baseline.path" must be a non-empty file path (e.g. "reports/qa-baseline.json").`);
      }
      config.baseline = { ...(config.baseline?.maxAge !== undefined ? { maxAge: config.baseline.maxAge } : {}), path: value.trim() };
    }
    if (config.baseline === undefined) config.baseline = {};
  }

  if (raw.perf !== undefined) {
    if (!isPlainObject(raw.perf)) configError(source, `"perf" must be an object (e.g. { "budgets": "perf.budgets.json" }).`);
    assertOnlyKeys(source, raw.perf, ["budgets"], "perf.");
    if (raw.perf.budgets !== undefined) {
      const value = raw.perf.budgets;
      if (typeof value !== "string" || value.trim() === "") {
        configError(source, `"perf.budgets" must be a non-empty file path (e.g. "perf.budgets.json").`);
      }
      config.perf = { budgets: value.trim() };
    } else {
      config.perf = {};
    }
  }

  return config;
}

export type LoadQaConfigOptions = {
  /** Directory to discover `qa.config.json` in (default: process.cwd()). */
  cwd?: string;
  /** Explicit file path (used by tests); defaults to `<cwd>/qa.config.json`. */
  path?: string | null;
};

/**
 * Locates, loads, parses, validates, and returns the configuration. A missing
 * file is not an error — it yields the built-in defaults (spec §3). Malformed
 * JSON and invalid values throw before the QA pipeline starts (spec §9/§11).
 */
export function loadQaConfig(options: LoadQaConfigOptions = {}): LoadedQaConfig {
  const cwd = options.cwd ?? process.cwd();
  const source = options.path ?? resolve(cwd, QA_CONFIG_FILENAME);
  if (!existsSync(source)) return { source: null, sourceLabel: "defaults", config: {} };

  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (error) {
    configError(source, `unable to read the file (${error instanceof Error ? error.message : String(error)}).`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    configError(source, error instanceof Error ? error.message : String(error));
  }
  if (raw === undefined) configError(source, "the configuration is empty or unparsable.");

  return { source, sourceLabel: basename(source), config: parseQaConfig(raw, source) };
}

/**
 * Resolves the config file (already defaulted by omission) into concrete
 * values. CLI arguments are merged on top of this in `parseArgs`, which keeps
 * the CLI as the highest-precedence source (spec §7).
 */
export function resolveQaConfig(config: QaConfig = {}): ResolvedQaConfig {
  return {
    maxPages: config.crawl?.maxPages ?? QA_CONFIG_DEFAULTS.maxPages,
    execution: config.execution?.enabled ?? QA_CONFIG_DEFAULTS.execution,
    coverage: config.coverage?.enabled ?? QA_CONFIG_DEFAULTS.coverage,
    regression: config.regression?.enabled ?? QA_CONFIG_DEFAULTS.regression,
    rootCause: config.rootCause?.enabled ?? QA_CONFIG_DEFAULTS.rootCause,
    history: config.history?.enabled ?? QA_CONFIG_DEFAULTS.history,
    historicalIntelligence: config.historicalIntelligence?.enabled ?? QA_CONFIG_DEFAULTS.historicalIntelligence,
    failOn: config.ci?.failOn ?? QA_CONFIG_DEFAULTS.failOn,
    gateMinSeverity: config.ci?.gateMinSeverity ?? QA_CONFIG_DEFAULTS.gateMinSeverity,
    baselineMaxAge: config.baseline?.maxAge ?? QA_CONFIG_DEFAULTS.baselineMaxAge,
    baselinePath: config.baseline?.path ?? QA_CONFIG_DEFAULTS.baselinePath,
    perfBudgetsPath: config.perf?.budgets ?? QA_CONFIG_DEFAULTS.perfBudgetsPath,
  };
}
