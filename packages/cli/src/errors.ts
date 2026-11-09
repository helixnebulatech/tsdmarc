// Errors of the command-line interface.

/** Raised when a configuration file has missing or invalid settings. */
export class ConfigurationError extends Error {
  override name = 'ConfigurationError';
}

/**
 * Python's `SystemExit`: thrown where parsedmarc calls `sys.exit()`, so
 * every `finally` (closing output clients, the mailbox connection, signal
 * handlers) still runs. `run()` turns it into the process exit status.
 */
export class SystemExit extends Error {
  override name = 'SystemExit';
  readonly code: number;

  constructor(code: number) {
    super(`SystemExit: ${code}`);
    this.code = code;
  }
}
