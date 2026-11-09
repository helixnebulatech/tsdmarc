// Command-line arguments (parsedmarc's argparse setup), with commander.

import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { VERSION } from 'tsdmarc';

import { SystemExit } from './errors';
import { type CliArgs, DEFAULT_ARGS } from './options';

// Python's float() and int() syntax for option values.
const FLOAT_VALUE =
  /^\s*[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)\s*$/iu;
const INT_VALUE = /^\s*[+-]?\d(?:_?\d)*\s*$/u;

function parseFloatValue(value: string): number {
  if (!FLOAT_VALUE.test(value)) {
    throw new InvalidArgumentError(`invalid float value: '${value}'`);
  }
  const text = value.trim().toLowerCase().replaceAll('_', '');
  if (text.endsWith('inf') || text.endsWith('infinity')) {
    return text.startsWith('-') ? -Infinity : Infinity;
  }
  return text.endsWith('nan') ? Number.NaN : Number(text);
}

function parseIntValue(value: string): number {
  if (!INT_VALUE.test(value)) {
    throw new InvalidArgumentError(`invalid int value: '${value}'`);
  }
  return Number(value.trim().replaceAll('_', ''));
}

/** The argument parser of the `tsdmarc` command. */
export function createArgumentParser(): Command {
  const program = new Command();
  program
    .name('tsdmarc')
    .description('Parses DMARC and SMTP TLS reports')
    .argument(
      '[file_path...]',
      'one or more paths to aggregate, failure, or SMTP TLS report ' +
        'files, emails, mbox files, or directories containing them',
    )
    .option(
      '-c, --config-file <config_file>',
      'a path to a configuration file (--silent implied)',
    )
    .option(
      '-r, --recursive',
      'search directories given as file_path recursively, and ' +
        "enable '**' recursion in glob patterns",
    )
    .option(
      '--strip-attachment-payloads',
      'remove attachment payloads from failure report output',
    )
    .option(
      '-o, --output <output>',
      'write output files to the given directory',
    )
    .option(
      '--aggregate-json-filename <name>',
      'filename for the aggregate JSON output file',
      DEFAULT_ARGS.aggregateJsonFilename,
    )
    .option(
      '--failure-json-filename <name>',
      'filename for the failure JSON output file',
      DEFAULT_ARGS.failureJsonFilename,
    )
    .option(
      '--smtp-tls-json-filename <name>',
      'filename for the SMTP TLS JSON output file',
      DEFAULT_ARGS.smtpTlsJsonFilename,
    )
    .option(
      '--aggregate-csv-filename <name>',
      'filename for the aggregate CSV output file',
      DEFAULT_ARGS.aggregateCsvFilename,
    )
    .option(
      '--failure-csv-filename <name>',
      'filename for the failure CSV output file',
      DEFAULT_ARGS.failureCsvFilename,
    )
    .option(
      '--smtp-tls-csv-filename <name>',
      'filename for the SMTP TLS CSV output file',
      DEFAULT_ARGS.smtpTlsCsvFilename,
    )
    .option(
      '-n, --nameservers <nameservers...>',
      'nameservers to query: IP addresses, https:// URLs (DNS over ' +
        'HTTPS), and/or tls://ip[:port][#hostname] (DNS over TLS)',
    )
    .option(
      '-t, --dns-timeout <seconds>',
      'number of seconds to wait for an answer from DNS (default: 2.0) ' +
        '(also accepted as --dns_timeout)',
      parseFloatValue,
      DEFAULT_ARGS.dnsTimeout,
    )
    .option(
      '--dns-retries <retries>',
      'number of times to retry DNS queries on timeout or other ' +
        'transient errors (default: 0)',
      parseIntValue,
      DEFAULT_ARGS.dnsRetries,
    )
    .option('--offline', 'do not make online queries for geolocation or DNS')
    .option('-s, --silent', 'only print errors')
    .option('-w, --warnings', 'print warnings in addition to errors')
    .option('--verbose', 'more verbose output')
    .option('--debug', 'print debugging information')
    .option('--log-file <log_file>', 'output logging to a file')
    .option(
      '--no-prettify-json',
      'output JSON in a single line without indentation',
    )
    .version(VERSION, '-v, --version')
    .helpOption('-h, --help', 'show this help message and exit')
    .exitOverride();
  return program;
}

/** argparse accepts `--dns_timeout` as an alias of `--dns-timeout`. */
function normalizeArgv(argv: readonly string[]): string[] {
  const result: string[] = [];
  let afterSeparator = false;
  for (const arg of argv) {
    if (afterSeparator) {
      result.push(arg);
    } else if (arg === '--') {
      afterSeparator = true;
      result.push(arg);
    } else if (arg === '--dns_timeout' || arg.startsWith('--dns_timeout=')) {
      result.push(arg.replace('--dns_timeout', '--dns-timeout'));
    } else {
      result.push(arg);
    }
  }
  return result;
}

interface ParsedOptions {
  configFile?: string;
  recursive?: boolean;
  stripAttachmentPayloads?: boolean;
  output?: string;
  aggregateJsonFilename: string;
  failureJsonFilename: string;
  smtpTlsJsonFilename: string;
  aggregateCsvFilename: string;
  failureCsvFilename: string;
  smtpTlsCsvFilename: string;
  nameservers?: string[];
  dnsTimeout: number;
  dnsRetries: number;
  offline?: boolean;
  silent?: boolean;
  warnings?: boolean;
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
  prettifyJson: boolean;
}

/**
 * Parse the command line. `--help` and `--version` throw `SystemExit(0)`,
 * usage errors `SystemExit(2)` (argparse's statuses), after commander has
 * written its output.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const program = createArgumentParser();
  try {
    program.parse(normalizeArgv(argv), { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      const success =
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help';
      throw new SystemExit(success ? 0 : 2);
    }
    throw error;
  }
  const options = program.opts<ParsedOptions>();
  return {
    filePath: [...((program.processedArgs[0] as string[] | undefined) ?? [])],
    configFile: options.configFile ?? null,
    recursive: options.recursive ?? false,
    stripAttachmentPayloads: options.stripAttachmentPayloads ?? false,
    output: options.output ?? null,
    aggregateJsonFilename: options.aggregateJsonFilename,
    failureJsonFilename: options.failureJsonFilename,
    smtpTlsJsonFilename: options.smtpTlsJsonFilename,
    aggregateCsvFilename: options.aggregateCsvFilename,
    failureCsvFilename: options.failureCsvFilename,
    smtpTlsCsvFilename: options.smtpTlsCsvFilename,
    nameservers: options.nameservers ?? null,
    dnsTimeout: options.dnsTimeout,
    dnsRetries: options.dnsRetries,
    offline: options.offline ?? false,
    silent: options.silent ?? false,
    warnings: options.warnings ?? false,
    verbose: options.verbose ?? false,
    debug: options.debug ?? false,
    logFile: options.logFile ?? null,
    prettifyJson: options.prettifyJson,
  };
}
