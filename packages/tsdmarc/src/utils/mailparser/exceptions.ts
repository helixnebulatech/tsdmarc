// Port of the mail-parser 4.8.0 exceptions (`mailparser/exceptions.py`)
// that the string parser can raise.

/** mail-parser's `MailParserError`: base of its exceptions. */
export class MailParserError extends Error {
  override name = 'MailParserError';
}

/**
 * mail-parser's `MailParserRecursionError`: the message is nested too
 * deeply for Python's `email` parser (a "multipart bomb").
 */
export class MailParserRecursionError extends MailParserError {
  override name = 'MailParserRecursionError';
}
