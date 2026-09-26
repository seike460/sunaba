export class SunabaError extends Error {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "SunabaError";
    this.code = code;
    this.cause = cause;
  }
}

export class TimeoutError extends SunabaError {
  constructor(message: string, cause?: unknown) {
    super("Timeout", message, cause);
    this.name = "TimeoutError";
  }
}

export class StateError extends SunabaError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string, message: string) {
    super("UnexpectedState", message);
    this.name = "StateError";
    this.expected = expected;
    this.actual = actual;
  }
}
