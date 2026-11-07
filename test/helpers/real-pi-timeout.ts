/**
 * real-pi-timeout.ts — one clock for every suite that boots a REAL pi session.
 *
 * These suites build an actual `AgentSession` (pi's own resource loader, model
 * registry and session manager) instead of a mock, which is the point: they pin
 * behaviour that lives entirely inside pi. The cost is that construction is
 * CPU-bound and slow on a cold module graph, and it competes with every other
 * file vitest runs in parallel.
 *
 * The budget has drifted upward twice for the same reason — vitest's 5s default,
 * then 30s — and each time it surfaced as an unrelated-looking assertion failure
 * or `Test timed out in Ns` in a full-suite run while the same file passed when
 * run alone. That is not a flaky test, it is a timing assumption about the host:
 * a full run on a loaded box boots these sessions several times slower than a
 * single-file run does.
 *
 * So the budget lives here, once, and is deliberately generous rather than
 * tight. A real hang still terminates — just later — and nothing about the
 * assertions depends on speed. `hookTimeout` is kept in step because the
 * fixtures that build a session live in hooks as often as in the tests.
 */
export const REAL_PI_TEST_TIMEOUT_MS = 120_000;

/** Apply the real-pi budget to the current test file. */
export const REAL_PI_CONFIG = {
    testTimeout: REAL_PI_TEST_TIMEOUT_MS,
    hookTimeout: REAL_PI_TEST_TIMEOUT_MS,
} as const;
