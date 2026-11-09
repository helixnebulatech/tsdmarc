// Port of tests/test_grafana_loki_dashboard.py (the dashboard checks; the
// dev-stack bootstrap script is not part of tsdmarc).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseReportFile } from '../report-file';
import type { AggregateReport, FailureReport, SMTPTLSReport } from '../types';
import { LokiClient, type LokiReportType } from './loki';

type Json = Record<string, unknown>;

interface Target {
  expr: string;
  refId: string;
  queryType?: string;
  step?: unknown;
  datasource: unknown;
}

interface Panel {
  type: string;
  title?: string;
  gridPos: unknown;
  datasource?: unknown;
  panels?: Panel[];
  targets?: Target[];
  transformations?: { id: string; options: Json }[];
  options?: Json;
  fieldConfig?: {
    overrides?: { properties: { id: string; value: unknown }[] }[];
  };
}

interface Dashboard {
  panels: Panel[];
  time: unknown;
  __inputs: { name: string; pluginId: string }[];
}

const repoFile = (path: string): string =>
  fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

const load = (path: string): Dashboard =>
  JSON.parse(readFileSync(repoFile(path), 'utf8')) as Dashboard;

const DATASOURCE = { type: 'loki', uid: '${DS_LOKI}' };
const SELECTOR = /\{([^{}]*report_type="(\w+)"[^{}]*)\}/u;
const JSON_STAGE = /\|\s*json\b([^|[)]*)/gu;
const LABEL_FORMAT = /label_format\s+(\w+)=/gu;
const BY_CLAUSE = /\bby \(([^)]*)\)/gu;
const DURATION = /\[([^\]]+)\]/gu;
const UNWRAP_SESSION_COUNT = /unwrap\s+\w+_session_count/u;

function* panels(dashboard: Dashboard): Generator<Panel> {
  for (const panel of dashboard.panels) {
    yield panel;
    yield* panel.panels ?? [];
  }
}

function* targets(dashboard: Dashboard): Generator<[Panel, Target]> {
  for (const panel of panels(dashboard)) {
    for (const target of panel.targets ?? []) {
      yield [panel, target];
    }
  }
}

function selector(expr: string): [string, string] {
  const match = SELECTOR.exec(expr);
  expect(match, expr).not.toBeNull();
  return [match?.[1] ?? '', match?.[2] ?? ''];
}

function jsonStages(expr: string): string[] {
  return [...expr.matchAll(JSON_STAGE)].map(match => match[1] ?? '');
}

/** Log lines the Loki output writes for one sample report. */
async function lines(
  reportType: LokiReportType,
  path: string,
): Promise<Json[]> {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const parsed = await parseReportFile(repoFile(path), { offline: true });
  const client = new LokiClient('http://loki:3100');
  if (reportType === 'aggregate') {
    await client.saveAggregateReportToLoki(parsed.report as AggregateReport);
  } else if (reportType === 'failure') {
    await client.saveFailureReportToLoki(parsed.report as FailureReport);
  } else {
    await client.saveSmtpTlsReportToLoki(parsed.report as SMTPTLSReport);
  }
  return bodies.flatMap(body =>
    (
      JSON.parse(body) as { streams: { values: [string, string][] }[] }
    ).streams.flatMap(stream =>
      stream.values.map(([, line]) => JSON.parse(line) as Json),
    ),
  );
}

async function sampleFields(): Promise<Record<string, Set<string>>> {
  const samples: [LokiReportType, string][] = [
    ['aggregate', 'samples/aggregate/!example.com!1538204542!1538463818.xml'],
    ['failure', 'samples/failure/dmarc_ruf_report_linkedin.eml'],
    ['smtp_tls', 'samples/smtp_tls/google.com_smtp_tls_report.eml'],
  ];
  const fields: Record<string, Set<string>> = {};
  for (const [reportType, path] of samples) {
    // oxlint-disable-next-line no-await-in-loop -- one sample at a time
    const pushed = await lines(reportType, path);
    fields[reportType] = new Set(pushed.flatMap(line => Object.keys(line)));
  }
  // Columns the CSV rows only carry when the report has them.
  for (const name of ['org_extra_contact_info', 'fo', 'np']) {
    fields.aggregate?.add(name);
  }
  fields.failure?.add('sample_headers_only');
  for (const name of [
    'result_type',
    'sending_mta_ip',
    'receiving_ip',
    'receiving_mx_hostname',
    'failure_reason_code',
    'additional_info_uri',
    'policy_strings',
    'mx_host_patterns',
  ]) {
    fields.smtp_tls?.add(name);
  }
  return fields;
}

const difference = (used: Iterable<string>, known: Set<string>): string[] =>
  [...used].filter(name => !known.has(name));

describe('Grafana Loki dashboard', () => {
  const dashboard = load('dashboards/grafana/Grafana-DMARC_Reports-Loki.json');
  const postgres = load(
    'dashboards/grafana/Grafana-DMARC_Reports-PostgreSQL.json',
  );
  let fields: Record<string, Set<string>> = {};

  beforeAll(async () => {
    fields = await sampleFields();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on the last seven days', () => {
    expect(dashboard.time).toEqual({ from: 'now-7d', to: 'now' });
  });

  it('declares the Loki datasource input', () => {
    expect(dashboard.__inputs).toHaveLength(1);
    expect(dashboard.__inputs[0]).toMatchObject({
      name: 'DS_LOKI',
      pluginId: 'loki',
    });
  });

  it('has the same layout as the PostgreSQL dashboard', () => {
    const layout = (d: Dashboard): unknown[] =>
      [...panels(d)].map(p => [p.type, p.title, p.gridPos]);
    expect(layout(dashboard)).toEqual(layout(postgres));
  });

  it('uses the Loki input in every query', () => {
    for (const [panel, target] of targets(dashboard)) {
      expect(panel.datasource, panel.title).toEqual(DATASOURCE);
      expect(target.datasource, panel.title).toEqual(DATASOURCE);
    }
  });

  it('selects parsedmarc streams in every query', () => {
    for (const [, target] of targets(dashboard)) {
      const [labels, reportType] = selector(target.expr);
      expect(labels).toContain('job="parsedmarc"');
      expect(['aggregate', 'failure', 'smtp_tls']).toContain(reportType);
    }
  });

  it('filters aggregate queries by the domain variable', () => {
    for (const [, target] of targets(dashboard)) {
      const [labels, reportType] = selector(target.expr);
      if (reportType === 'aggregate') {
        expect(labels).toContain('domain=~"$domain"');
      }
    }
  });

  it('names the fields of every json stage', () => {
    // A bare `| json` turns every field into a label and hits
    // max_query_series.
    for (const [, target] of targets(dashboard)) {
      for (const stage of jsonStages(target.expr)) {
        expect(stage.trim(), target.expr).not.toBe('');
      }
    }
  });

  it('only queries fields the Loki output writes', () => {
    for (const [panel, target] of targets(dashboard)) {
      const { expr } = target;
      const [, reportType] = selector(expr);
      const known = new Set([
        ...(fields[reportType] ?? []),
        ...[...expr.matchAll(LABEL_FORMAT)].map(match => match[1] ?? ''),
      ]);
      const used = jsonStages(expr).flatMap(stage =>
        stage.split(',').map(field => field.trim()),
      );
      expect(difference(used, known), `${panel.title} ${target.refId}`).toEqual(
        [],
      );
    }
  });

  it('only extracts columns the log lines have', () => {
    for (const panel of panels(dashboard)) {
      for (const transformation of panel.transformations ?? []) {
        if (transformation.id !== 'extractFields') {
          continue;
        }
        const [, reportType] = selector(panel.targets?.[0]?.expr ?? '');
        const paths = (
          transformation.options.jsonPaths as { path: string }[]
        ).map(path => path.path);
        expect(
          difference(paths, fields[reportType] ?? new Set()),
          panel.title,
        ).toEqual([]);
      }
    }
  });

  it('keeps range query buckets inside the time range', () => {
    // A fixed 1d step stamps the current bucket after `now`.
    for (const [, target] of targets(dashboard)) {
      if (target.queryType === 'range' && target.expr.includes('unwrap')) {
        expect(target).not.toHaveProperty('step');
        expect(target.expr).not.toContain('$interval');
      }
    }
  });

  it('groups report dedup by reporter too', () => {
    // report_id is only unique per reporter.
    for (const [, target] of targets(dashboard)) {
      for (const match of target.expr.matchAll(BY_CLAUSE)) {
        const names = (match[1] ?? '').split(',').map(name => name.trim());
        if (names.includes('report_id')) {
          expect(names).toContain('org_name');
        }
      }
    }
  });

  it('has no additive legend calcs on fixed-lookback series', () => {
    for (const panel of panels(dashboard)) {
      let fixed = false;
      for (const target of panel.targets ?? []) {
        if (target.queryType !== 'range') {
          continue;
        }
        for (const match of target.expr.matchAll(DURATION)) {
          if (match[1] !== '$__interval' && match[1] !== '$__auto') {
            fixed = true;
          }
        }
      }
      if (fixed && panel.type === 'timeseries') {
        const legend = panel.options?.legend as { calcs?: string[] };
        const calcs = legend.calcs ?? [];
        expect(calcs, panel.title).not.toContain('sum');
        expect(calcs, panel.title).not.toContain('count');
      }
    }
  });

  it('uses one pie slice per row', () => {
    for (const panel of panels(dashboard)) {
      if (panel.type === 'piechart') {
        const reduce = panel.options?.reduceOptions as { values?: unknown };
        expect(reduce.values, panel.title).toBeTruthy();
      }
    }
  });

  it('names table counts after what they count', () => {
    for (const panel of panels(dashboard)) {
      if (panel.type !== 'table') {
        continue;
      }
      const names = new Set<string>();
      for (const transformation of panel.transformations ?? []) {
        if (transformation.id === 'organize') {
          const renames = (transformation.options.renameByName ?? {}) as Record<
            string,
            string
          >;
          for (const [source, target] of Object.entries(renames)) {
            if (source.startsWith('Value')) {
              names.add(target);
            }
          }
        }
      }
      const shown = new Set(
        (panel.fieldConfig?.overrides ?? []).flatMap(override =>
          override.properties
            .filter(property => property.id === 'displayName')
            .map(property => String(property.value)),
        ),
      );
      expect(difference(names, shown), panel.title).toEqual([]);
    }
  });

  it('combines one frame per series in summary tables', () => {
    for (const panel of panels(dashboard)) {
      const ids = (panel.transformations ?? []).map(t => t.id);
      if (ids.includes('labelsToFields')) {
        expect(
          ids.includes('merge') || ids.includes('joinByField'),
          panel.title,
        ).toBe(true);
      }
    }
  });

  it('sums TLS session counts over policy rows only', () => {
    // Failure-detail rows repeat failed_session_count.
    for (const [, target] of targets(dashboard)) {
      if (UNWRAP_SESSION_COUNT.test(target.expr)) {
        expect(target.expr).toContain('policy_type!=""');
      }
    }
  });
});
