// Process a Maildir like a mailbox: parse every report email in it, move
// the messages to Archive/Aggregate, Archive/Failure, ... and save the
// results as JSON and CSV files.
//
//   node src/maildir.ts [path/to/maildir] [output-directory]
//
// Without arguments it builds a temporary Maildir from the repository's
// sample emails, so it runs offline and leaves nothing behind.
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getDmarcReportsFromMailbox,
  MaildirConnection,
  saveOutput,
} from 'tsdmarc';

const samples = fileURLToPath(new URL('../../../samples/', import.meta.url));

/** Copy the sample report emails into a new Maildir's `new/` folder. */
async function sampleMaildir(directory: string): Promise<void> {
  for (const subdirectory of ['cur', 'new', 'tmp']) {
    await mkdir(path.join(directory, subdirectory), { recursive: true });
  }
  let count = 0;
  for (const type of ['aggregate', 'failure', 'smtp_tls']) {
    for (const name of await readdir(path.join(samples, type))) {
      if (name.endsWith('.eml')) {
        count += 1;
        await copyFile(
          path.join(samples, type, name),
          path.join(directory, 'new', `${Date.now()}.${count}.example`),
        );
      }
    }
  }
}

const temporary = await mkdtemp(path.join(tmpdir(), 'tsdmarc-maildir-'));
const maildirPath = process.argv[2] ?? path.join(temporary, 'Maildir');
const outputDirectory = process.argv[3] ?? path.join(temporary, 'output');
if (process.argv[2] === undefined) {
  await sampleMaildir(maildirPath);
}

const connection = new MaildirConnection(maildirPath);
try {
  const results = await getDmarcReportsFromMailbox(connection, {
    // For a Maildir, "INBOX" (the default) is the Maildir itself.
    reportsFolder: 'INBOX',
    archiveFolder: 'Archive',
    offline: true,
  });
  await saveOutput(results, { outputDirectory });

  process.stdout.write(
    [
      `Aggregate reports: ${results.aggregateReports.length}`,
      `Failure reports:   ${results.failureReports.length}`,
      `SMTP TLS reports:  ${results.smtpTlsReports.length}`,
      `Output files in ${outputDirectory}: ${(await readdir(outputDirectory)).join(', ')}`,
      '',
    ].join('\n'),
  );
} finally {
  await connection.close();
  if (process.argv[2] === undefined) {
    await rm(temporary, { recursive: true, force: true });
  }
}
