// Port of the message defects of Python's `email.errors`.
//
// The parser never throws on malformed input; it records defects on the
// message instead. mail-parser reports each one as
// `"<ClassName>: <class docstring>"`, so every class keeps both.

/** Base class for a message defect (`email.errors.MessageDefect`). */
export class MessageDefect {
  /** Python's class docstring, as mail-parser prints it. */
  static readonly doc: string = 'Base class for a message defect.';
  readonly name: string = 'MessageDefect';
  readonly line: string | null;

  constructor(line: string | null = null) {
    this.line = line;
  }

  /** The docstring of this defect's class (`e.__doc__`). */
  get doc(): string {
    return (this.constructor as typeof MessageDefect).doc;
  }
}

export class NoBoundaryInMultipartDefect extends MessageDefect {
  static override readonly doc: string =
    'A message claimed to be a multipart but had no boundary parameter.';
  override readonly name: string = 'NoBoundaryInMultipartDefect';
}

export class StartBoundaryNotFoundDefect extends MessageDefect {
  static override readonly doc: string =
    'The claimed start boundary was never found.';
  override readonly name: string = 'StartBoundaryNotFoundDefect';
}

export class CloseBoundaryNotFoundDefect extends MessageDefect {
  static override readonly doc: string =
    'A start boundary was found, but not the corresponding close boundary.';
  override readonly name: string = 'CloseBoundaryNotFoundDefect';
}

export class FirstHeaderLineIsContinuationDefect extends MessageDefect {
  static override readonly doc: string =
    'A message had a continuation line as its first header line.';
  override readonly name: string = 'FirstHeaderLineIsContinuationDefect';
}

export class MisplacedEnvelopeHeaderDefect extends MessageDefect {
  static override readonly doc: string =
    "A 'Unix-from' header was found in the middle of a header block.";
  override readonly name: string = 'MisplacedEnvelopeHeaderDefect';
}

export class MissingHeaderBodySeparatorDefect extends MessageDefect {
  static override readonly doc: string =
    'Found line with no leading whitespace and no colon before blank line.';
  override readonly name: string = 'MissingHeaderBodySeparatorDefect';
}

export class MultipartInvariantViolationDefect extends MessageDefect {
  static override readonly doc: string =
    'A message claimed to be a multipart but no subparts were found.';
  override readonly name: string = 'MultipartInvariantViolationDefect';
}

export class InvalidMultipartContentTransferEncodingDefect extends MessageDefect {
  static override readonly doc: string =
    'An invalid content transfer encoding was set on the multipart itself.';
  override readonly name: string =
    'InvalidMultipartContentTransferEncodingDefect';
}

export class InvalidBase64PaddingDefect extends MessageDefect {
  static override readonly doc: string =
    'base64 encoded sequence had an incorrect length';
  override readonly name: string = 'InvalidBase64PaddingDefect';
}

export class InvalidBase64CharactersDefect extends MessageDefect {
  static override readonly doc: string =
    'base64 encoded sequence had characters not in base64 alphabet';
  override readonly name: string = 'InvalidBase64CharactersDefect';
}

export class InvalidBase64LengthDefect extends MessageDefect {
  static override readonly doc: string =
    'base64 encoded sequence had invalid length (1 mod 4)';
  override readonly name: string = 'InvalidBase64LengthDefect';
}

export class InvalidHeaderDefect extends MessageDefect {
  static override readonly doc: string =
    'Header is not valid, message gives details.';
  override readonly name: string = 'InvalidHeaderDefect';
}

/** Python's `email.errors.MessageError`, the base of the errors below. */
export class MessageError extends Error {
  override name = 'MessageError';
}

/** Python's `email.errors.HeaderWriteError`. */
export class HeaderWriteError extends MessageError {
  override name = 'HeaderWriteError';
}

/** Python's `email.errors.HeaderParseError`. */
export class HeaderParseError extends MessageError {
  override name = 'HeaderParseError';
}

/**
 * Python's `RecursionError`, raised by the feed parser when a message is
 * nested deeper than CPython's recursion limit lets `_parsegen` go.
 */
export class RecursionError extends Error {
  override name = 'RecursionError';

  constructor(message = 'maximum recursion depth exceeded') {
    super(message);
  }
}
