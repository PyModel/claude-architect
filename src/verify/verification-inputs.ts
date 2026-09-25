/**
 * Paths whose content decides what project verification actually checks:
 * tests, test and build configuration, and dependency manifests. A candidate
 * that edits them can make its own verification pass, so verification alone
 * no longer proves anything about it — independent review or a person must.
 *
 * Source under test is deliberately absent: proving that changed source
 * passes unchanged tests is exactly what verification is for.
 */
const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:tests?|__tests__|spec|specs|testdata|fixtures)\//u,
  /\.(?:test|spec)\.[^/]+$/u,
  /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.(?:py|go|rb|rs|exs?)$/u,
  /(?:^|\/)[^/]+(?:Test|Tests|Spec)\.(?:java|kt|cs|swift|scala)$/u,
  /(?:^|\/)conftest\.py$/u,
];

/** Whether a repository path is a test file or lives in a test tree. */
export function isTestPath(candidate: string): boolean {
  return TEST_PATH_PATTERNS.some(pattern => pattern.test(candidate));
}

const VERIFICATION_INPUT_PATTERNS: readonly RegExp[] = [
  ...TEST_PATH_PATTERNS,
  // Test runner, compiler, and task configuration.
  /(?:^|\/)(?:vitest|vite|jest|mocha|karma|playwright|cypress|ava|babel|webpack|rollup|esbuild)\.config\.[^/]+$/u,
  /(?:^|\/)\.(?:mocharc|babelrc|nycrc|c8rc)(?:\.[^/]+)?$/u,
  /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/u,
  /(?:^|\/)(?:pytest|tox|setup)\.(?:ini|cfg)$/u,
  /(?:^|\/)(?:Makefile|GNUmakefile|justfile|Taskfile\.ya?ml|Rakefile|build\.gradle(?:\.kts)?|pom\.xml)$/u,
  // Dependency manifests and lockfiles.
  /(?:^|\/)package\.json$/u,
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/u,
  /(?:^|\/)(?:pyproject\.toml|requirements[^/]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock)$/u,
  /(?:^|\/)(?:Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Gemfile(?:\.lock)?|mix\.(?:exs|lock))$/u,
  // Attribute and ignore rules change which bytes Git and tools see.
  /(?:^|\/)\.git(?:attributes|ignore|modules)$/u,
];

export function verificationInputPaths(changedPaths: readonly string[]): string[] {
  return changedPaths.filter(changed =>
    VERIFICATION_INPUT_PATTERNS.some(pattern => pattern.test(changed)));
}
