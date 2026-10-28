export type Status = "PASS" | "WARNING" | "FAIL" | "INFO";
export type LocatorQuality = "high" | "medium" | "low";

export type BoundingBox = { x: number; y: number; width: number; height: number };

export type DiscoveredElement = {
  tag: string;
  role: string | null;
  text: string;
  ariaLabel: string | null;
  placeholder: string | null;
  name: string | null;
  id: string | null;
  testId: string | null;
  type: string | null;
  hasExplicitType: boolean;
  autocomplete: string | null;
  href: string | null;
  alt: string | null;
  visible: boolean;
  enabled: boolean;
  boundingBox: BoundingBox | null;
  interactive: boolean;
  accessibleName: string | null;
  recommendedLocator: string;
  locatorQuality: LocatorQuality;
  formIndex?: number | null;
};

export type IssueElement = Pick<DiscoveredElement, "tag" | "role" | "text" | "ariaLabel" | "id" | "testId" | "type" | "name" | "placeholder" | "accessibleName" | "href" | "alt" | "visible" | "enabled" | "recommendedLocator" | "locatorQuality">;
export type IssueExample = { element?: IssueElement; detail?: string };
export type Issue = { status: Status; code: string; message: string; count?: number; occurrences?: number; element?: IssueElement; examples?: IssueExample[] };
export type LinkResult = { url: string; status: number | null; type: "OK" | "REDIRECT" | "BROKEN" | "RESTRICTED" | "ERROR"; error?: string };
export type ConsoleDiagnostic = { message: string; source: string | null; category: "first-party" | "third-party" | "network"; status: "WARNING" | "INFO" };
export type AuthenticationDiagnostic = { method: "none" | "basic" | "authorization" | "basic-and-authorization"; usernamePresent: boolean; passwordPresent: boolean; authorizationPresent: boolean; accepted: boolean | null };

export type TestCategory = "navigation" | "button" | "input" | "form" | "validation";
export type RiskLevel = "safe" | "review" | "high-risk";
export type ScenarioType = "structural" | "behavioral";

// QA analysis intent model. Element scenarios are decorated with these optional
// fields by the analysis layer; they never change how the scenario is generated.
export type Priority = "P1" | "P2" | "P3" | "P4";
export type IntentCategory =
  | "NAVIGATION"
  | "ACCESSIBILITY"
  | "SEARCH"
  | "AUTHENTICATION"
  | "FORM"
  | "MEDIA"
  | "LANGUAGE"
  | "PROFILE"
  | "CONTENT"
  | "VALIDATION"
  | "RESPONSIVE"
  | "ERROR_HANDLING";

export type SourceElementSnapshot = { tag: string; role: string | null; id: string | null; name: string | null; text: string; type: string | null; href: string | null; placeholder: string | null; accessibleName: string | null; locatorQuality: LocatorQuality; visible: boolean; occurrences: number };

export type GeneratedScenario = {
  id: string;
  category: TestCategory;
  title: string;
  description: string;
  preconditions: string[];
  steps: string[];
  expected: string[];
  locator: string | null;
  risk: RiskLevel;
  riskReason: string;
  scenarioType: ScenarioType;
  automated: boolean;
  sourceElement: SourceElementSnapshot;
  requiresSetup?: boolean;
  setupNote?: string;
  safetyNote?: string;
  intent?: IntentCategory;
  priority?: Priority;
  /** QA findings IDs this element scenario can confirm, where one exists. */
  findingIds?: string[];
};

export type GeneratedCounts = {
  total: number;
  navigation: number;
  button: number;
  input: number;
  form: number;
  validation: number;
  highRisk: number;
  safe: number;
  review: number;
  automated: number;
  manual: number;
  conditional: number;
};

export type GeneratedTestSuite = {
  generator: string;
  version: string;
  sourceUrl: string;
  sourceReport: string;
  generatedAt: string;
  scanSummary: { totalElements: number; interactiveElements: number; passes: number; warnings: number; failures: number; infos: number; linksChecked: number; brokenLinks: number };
  scenarios: GeneratedScenario[];
  counts: GeneratedCounts;
};

export type AccessPrerequisite = {
  type: "authentication-required" | "login-required" | "access-blocked" | "bot-protection" | "unknown" | "accessible";
  status: "REVIEW_REQUIRED" | "BLOCKED" | "PASS";
  message: string;
  httpStatus?: number | null;
  challenge?: string | null;
};

export type WaitUntil = "load" | "domcontentloaded" | "networkidle";

export type ReporterFormat = "line" | "json" | "junit";

export type PerformanceMetrics = {
  /** Time to First Byte (ms), or null if unavailable. */
  ttfb: number | null;
  /** First Contentful Paint (ms), or null if unavailable. */
  fcp: number | null;
  /** Largest Contentful Paint (ms), or null if unavailable. */
  lcp: number | null;
  /** Cumulative Layout Shift (dimensionless), or null if unavailable. */
  cls: number | null;
  /** DOM Content Loaded (ms), or null if unavailable. */
  domContentLoaded: number | null;
  /** Load Event End (ms), or null if unavailable. */
  loadEvent: number | null;
};

export type PerfBudgets = {
  ttfb?: number;
  fcp?: number;
  lcp?: number;
  cls?: number;
  domContentLoaded?: number;
  loadEvent?: number;
};

export type ScanOptions = {
  url: string;
  headed: boolean;
  timeout: number;
  outputPath: string;
  concurrency: number;
  /** Number of additional navigation attempts on failure (default: 0). */
  retries?: number;
  /** Playwright wait-until strategy for navigation (default: "domcontentloaded"). */
  waitUntil?: WaitUntil;
  /** Download/upload throughput ceiling in Kbps; 0 or omitted = no throttling (default: 0). */
  throttleKbps?: number;
  /** Comma-separated URL globs; only links matching at least one pattern are checked. */
  includePatterns?: string;
  /** Comma-separated URL globs; links matching any pattern are skipped. */
  excludePatterns?: string;
  /** When true, external (cross-origin) links are also health-checked (default: false). */
  followExternal?: boolean;
  /** Permit an intentional localhost/private-IP scan. CLI targets reject these by default. */
  allowPrivateNetwork?: boolean;
  /** Output format for console + JUnit: "line" (default), "json", or "junit". */
  reporter?: ReporterFormat;
  /** When true, emit GitHub Actions workflow commands for inline annotations. */
  githubAnnotations?: boolean;
  /** Path to a JSON file with performance budget thresholds. */
  perfBudgetsPath?: string;
  /** Path to a baseline screenshot file for visual regression comparison. */
  baselineScreenshotPath?: string;
  /** Percentage threshold (0–100) of pixels that may differ before a visual regression is reported (default: 0.1). */
  screenshotThreshold?: number;
};
export type ScanReport = {
  scan: { url: string; finalUrl: string; title: string; timestamp: string; durationMs: number; screenshotPath?: string; navigationStatus?: number; retryAttempts?: number; waitUntil?: WaitUntil; throttleKbps?: number; includePatterns?: string; excludePatterns?: string; followExternal?: boolean; baselineScreenshot?: { diffPixels: number; totalPixels: number; diffPercentage: number; threshold: number } };
  authentication: AuthenticationDiagnostic;
  access?: import("./qa/access.js").AccessDetection;
  accessPrerequisite?: AccessPrerequisite;
  summary: { totalElements: number; interactiveElements: number; passes: number; warnings: number; failures: number; infos: number; linksChecked: number; brokenLinks: number; consoleErrors: number; pageErrors: number; issueGroups: number; groupedIssueCounts: { passes: number; warnings: number; failures: number; infos: number } };
  page: { language: string | null; viewport: string | null; forms: number; images: number; links: number; buttons: number; inputs: number; textareas: number; selects: number; dialogs: number; media: number };
  /*   * Performance metrics collected during the scan, or null if unavailable. */
  performance?: PerformanceMetrics;
  elements: DiscoveredElement[];
  issues: Issue[];
  links: LinkResult[];
  consoleErrors: string[];
  consoleDiagnostics: ConsoleDiagnostic[];
  pageErrors: string[];
};
