/**
 * The archive build's code coverage report, shared by the seed that stores it and by the
 * Playwright worktree stub that has to produce a branch diff the very same report describes.
 *
 * Report payloads must match the GraphQL shapes in schemas/builds.graphql: the coverage report
 * reads `data.files` / `data.changedFiles`, and both are only surfaced when the report status
 * is READY.
 */

/**
 * Every file in the report, as `path → [coveredLines, executableLines]`. Coverage ratios and
 * the report summary are derived from these numbers below so the tiles, the per-file rows and
 * the file count can never drift apart.
 */
const COVERAGE_LINES: Record<string, [number, number]> = {
  "AcmeApp/AppDelegate.swift": [74, 132],
  "AcmeApp/Checkout/CheckoutViewModel.swift": [412, 468],
  "AcmeApp/Checkout/CheckoutSummaryView.swift": [52, 74],
  "AcmeApp/Checkout/PaymentMethodPicker.swift": [188, 232],
  "AcmeApp/Checkout/PromotionCodeField.swift": [96, 118],
  "AcmeApp/Checkout/OrderConfirmationView.swift": [134, 176],
  "AcmeApp/Search/SearchCoordinator.swift": [286, 374],
  "AcmeApp/Search/SearchResultsView.swift": [214, 268],
  "AcmeApp/Search/RecentSearchesStore.swift": [122, 138],
  "AcmeApp/Catalog/CatalogListViewModel.swift": [346, 402],
  "AcmeApp/Catalog/ProductDetailView.swift": [258, 336],
  "AcmeApp/Profile/ProfileSettingsView.swift": [166, 244],
  "AcmeApp/Profile/NotificationPreferences.swift": [88, 104],
  "AcmeApp/Onboarding/WelcomeFlowView.swift": [72, 148],
  "AcmeKit/Auth/AuthTokenStore.swift": [318, 332],
  "AcmeKit/Auth/DeviceAuthorizationClient.swift": [204, 226],
  "AcmeKit/Auth/KeychainAdapter.swift": [142, 164],
  "AcmeKit/Networking/NetworkClient.swift": [504, 548],
  "AcmeKit/Networking/RequestRetryPolicy.swift": [176, 192],
  "AcmeKit/Networking/MultipartEncoder.swift": [118, 158],
  "AcmeKit/Storage/CacheStore.swift": [196, 244],
  "AcmeKit/Storage/MigrationRunner.swift": [154, 218],
  "AcmeKit/Analytics/EventDispatcher.swift": [232, 264],
  "AcmeKit/Analytics/SessionTracker.swift": [108, 152],
};

/** Which of the above the build's diff touched, and how the diff itself was covered. */
const CHANGED_LINES: Record<string, ["MODIFIED" | "ADDED", number, number]> = {
  "AcmeApp/Search/SearchCoordinator.swift": ["MODIFIED", 148, 176],
  "AcmeApp/Search/SearchResultsView.swift": ["MODIFIED", 96, 112],
  "AcmeApp/Search/RecentSearchesStore.swift": ["ADDED", 64, 71],
  "AcmeKit/Auth/AuthTokenStore.swift": ["MODIFIED", 212, 236],
  "AcmeKit/Auth/DeviceAuthorizationClient.swift": ["ADDED", 118, 142],
  "AcmeKit/Auth/KeychainAdapter.swift": ["MODIFIED", 74, 88],
  "AcmeApp/Checkout/CheckoutSummaryView.swift": ["ADDED", 52, 74],
  "AcmeApp/Checkout/CheckoutViewModel.swift": ["MODIFIED", 186, 204],
  "AcmeApp/Checkout/PaymentMethodPicker.swift": ["MODIFIED", 92, 118],
  "AcmeApp/Checkout/PromotionCodeField.swift": ["ADDED", 48, 62],
  "AcmeApp/Checkout/OrderConfirmationView.swift": ["ADDED", 66, 98],
  "AcmeApp/Catalog/CatalogListViewModel.swift": ["MODIFIED", 138, 152],
  "AcmeApp/Catalog/ProductDetailView.swift": ["MODIFIED", 104, 148],
  "AcmeApp/Profile/ProfileSettingsView.swift": ["MODIFIED", 58, 96],
  "AcmeApp/Profile/NotificationPreferences.swift": ["ADDED", 42, 51],
  "AcmeApp/Onboarding/WelcomeFlowView.swift": ["MODIFIED", 24, 68],
  "AcmeKit/Networking/RequestRetryPolicy.swift": ["MODIFIED", 82, 90],
  "AcmeKit/Networking/MultipartEncoder.swift": ["ADDED", 56, 84],
  "AcmeKit/Storage/MigrationRunner.swift": ["MODIFIED", 71, 112],
  "AcmeKit/Analytics/SessionTracker.swift": ["ADDED", 38, 74],
};

/** Ratios are rounded to four places, the precision a real xccov export reports. */
const ratio = (covered: number, executable: number): number =>
  executable === 0 ? 0 : Math.round((covered / executable) * 10_000) / 10_000;

/**
 * Where a file's executable lines sit. Real source has declarations, closing braces and blank
 * lines between statements, so the numbers step irregularly rather than counting 1, 2, 3 — a
 * coverage strip that marks every single line of a hunk reads as a rendering bug.
 */
function executableLineNumbers(executableLines: number): number[] {
  const lines: number[] = [];
  // Past the import block every Swift file in this fixture opens with.
  let line = 12;
  for (let index = 0; index < executableLines; index += 1) {
    lines.push(line);
    line += index % 4 === 3 ? 2 : 1;
  }
  return lines;
}

/**
 * Splits executable lines into covered and uncovered, spreading the covered ones evenly so any
 * window of the file — and therefore any diff hunk overlaid on it — shows a believable mix.
 * The error-diffusion step lands on exactly `coveredCount` lines.
 */
function splitCoverage(lines: number[], coveredCount: number) {
  const covered: number[] = [];
  const uncovered: number[] = [];
  let credit = 0;
  for (const line of lines) {
    credit += coveredCount;
    if (credit >= lines.length) {
      credit -= lines.length;
      covered.push(line);
    } else {
      uncovered.push(line);
    }
  }
  return { covered, uncovered };
}

export const COVERAGE_FILES = Object.entries(COVERAGE_LINES).map(
  ([path, [coveredLines, executableLines]]) => ({
    target: path.split("/")[0]!,
    name: path.split("/").at(-1)!,
    path,
    coveredLines,
    executableLines,
    lineCoverage: ratio(coveredLines, executableLines),
  }),
);

export const CHANGED_COVERAGE_FILES = Object.entries(CHANGED_LINES).map(
  ([path, [changeType, changedCoveredLines, changedExecutableLines]]) => {
    const [coveredLines, executableLines] = COVERAGE_LINES[path]!;
    const { covered, uncovered } = splitCoverage(
      executableLineNumbers(executableLines),
      coveredLines,
    );
    return {
      path,
      changeType,
      changedCoveredLines,
      changedExecutableLines,
      changedLineCoverage: ratio(changedCoveredLines, changedExecutableLines),
      // Whole-file line numbers, which is what the diff overlay looks up: it
      // resolves a hunk's new-side line against the report, and a hunk can sit
      // anywhere in the file.
      coveredLineNumbers: covered,
      uncoveredLineNumbers: uncovered,
    };
  },
);

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export const COVERAGE_SUMMARY = (() => {
  const coveredLines = sum(COVERAGE_FILES.map((file) => file.coveredLines));
  const executableLines = sum(
    COVERAGE_FILES.map((file) => file.executableLines),
  );
  const changedCoveredLines = sum(
    CHANGED_COVERAGE_FILES.map((file) => file.changedCoveredLines),
  );
  const changedExecutableLines = sum(
    CHANGED_COVERAGE_FILES.map((file) => file.changedExecutableLines),
  );
  return {
    coveredLines,
    executableLines,
    lineCoverage: ratio(coveredLines, executableLines),
    targetCount: new Set(COVERAGE_FILES.map((file) => file.target)).size,
    fileCount: COVERAGE_FILES.length,
    changedCoveredLines,
    changedExecutableLines,
    changedLineCoverage: ratio(changedCoveredLines, changedExecutableLines),
  };
})();
