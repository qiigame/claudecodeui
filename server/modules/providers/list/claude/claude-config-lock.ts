/**
 * Serializes the small set of Claude operations that must observe a stable
 * process environment while the SDK has no per-call `CLAUDE_CONFIG_DIR`
 * option.  The lock is intentionally short-lived: callers should capture an
 * immutable environment snapshot inside it, then release it before doing any
 * network or model work.
 */

type AsyncOperation<T> = () => T | PromiseLike<T>;

let claudeEnvironmentQueue: Promise<void> = Promise.resolve();

/**
 * Runs one operation after earlier Claude environment-sensitive operations.
 * The queue's internal promise is always released in `finally`, so a failed
 * operation cannot permanently block subsequent turns.
 */
export function withClaudeEnvironmentLock<T>(operation: AsyncOperation<T>): Promise<T> {
  let release: (() => void) | undefined;
  const predecessor = claudeEnvironmentQueue;
  claudeEnvironmentQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  return predecessor.then(async () => {
    try {
      return await operation();
    } finally {
      release?.();
    }
  });
}

/**
 * Captures only defined environment values while holding the shared lock.
 * Returning a new object prevents a later fork's temporary mutation of
 * `process.env` from changing the caller's snapshot by reference.
 */
export function captureClaudeEnvironmentSnapshot(): Promise<Record<string, string>> {
  return withClaudeEnvironmentLock(() => {
    const snapshot: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        snapshot[key] = value;
      }
    }
    return snapshot;
  });
}
