// Parse one report file (aggregate, failure or SMTP TLS; XML, JSON, email,
// zip or gzip) and print it as JSON and CSV, with parsedmarc's snake_case
// keys and columns.
//
//   node src/parse-file.ts [path/to/report]
import { fileURLToPath } from 'node:url';

import {
  parsedAggregateReportsToCsv,
  parsedFailureReportsToCsv,
  parsedSmtpTlsReportsToCsv,
  parseReportFile,
  pyJsonDumps,
  toSnakeCaseKeys,
  type ParsedReport,
} from 'tsdmarc';

const defaultSample = fileURLToPath(
  new URL(
    '../../../samples/aggregate/example.net!example.com!1529366400!1529452799.xml',
    import.meta.url,
  ),
);
const file = process.argv[2] ?? defaultSample;

// `offline: true` skips DNS lookups and downloads: GeoIP comes from
// @tsdmarc/ipinfo-lite and the reverse DNS map from the bundled copy.
const parsed = await parseReportFile(file, { offline: true });

function toCsv(result: ParsedReport): string {
  switch (result.reportType) {
    case 'aggregate':
      return parsedAggregateReportsToCsv(result.report);
    case 'failure':
      return parsedFailureReportsToCsv(result.report);
    case 'smtp_tls':
      return parsedSmtpTlsReportsToCsv(result.report);
  }
}

process.stdout.write(`Report type: ${parsed.reportType}\n\n`);
// pyJsonDumps writes integers beyond 2^53 exactly, like Python's json.dumps.
process.stdout.write(
  `${pyJsonDumps(toSnakeCaseKeys(parsed.report), { indent: 2, ensureAscii: false })}\n\n`,
);
process.stdout.write(toCsv(parsed));
