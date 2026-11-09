// Loads the requests parsedmarc sends (recorded by
// scripts/generate-expected.py into expected.json) and turns each HTTP
// request into the client API call that sends it.

import { readFileSync } from 'node:fs';

import { INDEX_MAPPINGS } from '@tsdmarc/search-common/documents';
import { dataStreamMapping } from '@tsdmarc/search-common/dsl';
import { toCamelCaseKeys } from 'tsdmarc';

import type { ApiCall, FakeCluster } from './fake-client';

export interface RecordedRequest {
  method: string;
  path: string;
  params?: Record<string, string>;
  body?: unknown;
}

export interface ExpectedError {
  type: string;
  message: string;
}

/** Cluster state for a case (Recorder attributes in the Python script). */
export interface ClusterState {
  exists?: Record<string, boolean>;
  search_hits?: number;
  count?: number;
  field_mapping?: unknown;
  data_streams?: string[] | null;
  scroll_pages?: {
    _index: string;
    _id: string;
    _source: Record<string, unknown>;
  }[][];
}

export interface SaveCase {
  name: string;
  cluster: ClusterState;
  kind: 'aggregate' | 'failure' | 'smtp_tls';
  fixture?: string;
  report?: Record<string, unknown>;
  options: Record<string, unknown>;
  requests: RecordedRequest[];
  last_requests?: RecordedRequest[];
  request_count?: number;
  error?: ExpectedError;
}

export interface OtherCase {
  name: string;
  cluster: ClusterState;
  args: unknown[];
  options: Record<string, unknown>;
  requests: RecordedRequest[];
  error?: ExpectedError;
}

export interface Expected {
  saves: SaveCase[];
  others: OtherCase[];
  mappings: Record<'aggregate' | 'failure' | 'smtp_tls', unknown>;
}

const FIXTURES = new URL('../../../../fixtures/', import.meta.url);

export const expected: Expected = JSON.parse(
  readFileSync(new URL('expected.json', import.meta.url), 'utf8'),
) as Expected;

export function findCase<T extends { name: string }>(
  cases: readonly T[],
  name: string,
): T {
  const found = cases.find(item => item.name === name);
  if (found === undefined) {
    throw new Error(`no expected case named ${name}`);
  }
  return found;
}

/** The report a case saves, as tsdmarc's camelCase report object. */
export function caseReport<T>(item: SaveCase): T {
  let report = item.report;
  if (item.fixture !== undefined) {
    const fixture = JSON.parse(
      readFileSync(new URL(item.fixture, FIXTURES), 'utf8'),
    ) as { result: { report: Record<string, unknown> } };
    report = fixture.result.report;
  }
  return toCamelCaseKeys(report) as T;
}

/** A case's snake_case options as the camelCase options object. */
export function caseOptions<T>(options: Record<string, unknown>): T {
  return toCamelCaseKeys(options) as T;
}

function typedParam(value: string): unknown {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^\d+$/u.test(value)) {
    return Number(value);
  }
  return value;
}

function typedParams(request: RecordedRequest): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request.params ?? {}).map(([key, value]) => [
      key,
      typedParam(value),
    ]),
  );
}

function bodyObject(request: RecordedRequest): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}

/** The Elasticsearch JS client call that sends a recorded HTTP request. */
export function toApiCall(request: RecordedRequest): ApiCall {
  const parts = request.path.split('/').filter(Boolean);
  const [first = '', second = '', , fourth = ''] = parts;
  const params = typedParams(request);
  const body = bodyObject(request);
  // The index name in the path is the variable part: `HEAD x`, `POST x/_doc`.
  const route = `${request.method} ${parts
    .map((part, index) => (index === 0 && !part.startsWith('_') ? 'x' : part))
    .join('/')}`;
  switch (route) {
    case 'HEAD x':
      return { api: 'indices.exists', params: { index: first } };
    case 'PUT x':
      return { api: 'indices.create', params: { index: first, ...body } };
    case 'DELETE x':
      return { api: 'indices.delete', params: { index: first } };
    case 'PUT x/_mapping':
      return { api: 'indices.putMapping', params: { index: first, ...body } };
    case `GET x/_mapping/field/${fourth}`:
      return {
        api: 'indices.getFieldMapping',
        params: { index: first, fields: fourth.split(',') },
      };
    case `GET _data_stream/${second}`:
      return {
        api: 'indices.getDataStream',
        params: { name: second, ...params },
      };
    case `PUT _data_stream/${second}`:
      return { api: 'indices.createDataStream', params: { name: second } };
    case `PUT _index_template/${second}`:
      return {
        api: 'indices.putIndexTemplate',
        params: { name: second, ...body },
      };
    case 'POST x/_search':
      return { api: 'search', params: { index: first, ...params, ...body } };
    case 'POST _search/scroll':
      return { api: 'scroll', params: body };
    case 'DELETE _search/scroll':
      return { api: 'clearScroll', params: body };
    case 'POST x/_doc':
      return {
        api: 'index',
        params: { index: first, document: body, ...params },
      };
    case 'GET x/_refresh':
      return { api: 'indices.refresh', params: { index: first } };
    case 'GET x/_count':
    case 'POST x/_count':
      return { api: 'count', params: { index: first, ...params, ...body } };
    case 'POST x/_update_by_query':
      return {
        api: 'updateByQuery',
        params: { index: first, ...params, ...body },
      };
    case 'PUT _bulk':
      return { api: 'bulk', params: { operations: request.body } };
    default:
      throw new Error(`no API call for ${request.method} ${request.path}`);
  }
}

const ADDED_BEFORE_DELETE = /^migrate legacy fo long/u;
const TRAILING_WILDCARD = /\*$/u;

type TemplateBody = Record<string, unknown> & {
  _meta?: { description?: string };
  template?: Record<string, unknown>;
};

/**
 * The index template tsdmarc puts: its own name in the description, and the
 * save functions' mappings when they put it.
 */
function tsdmarcTemplate(
  request: RecordedRequest,
  mappings?: Parameters<typeof dataStreamMapping>[0],
): RecordedRequest {
  const template = request.body as TemplateBody;
  const description = template._meta?.description ?? '';
  return {
    ...request,
    body: {
      ...template,
      _meta: { description: description.replace('parsedmarc', 'tsdmarc') },
      ...(mappings === undefined
        ? {}
        : {
            template: {
              ...template.template,
              mappings: dataStreamMapping(mappings),
            },
          }),
    },
  };
}

/**
 * When an index or alias holds a data stream's name, tsdmarc asks for the
 * stream again before failing, in case another writer created it between the
 * two checks.
 */
function recheckStreams(
  item: SaveCase | OtherCase,
  requests: readonly RecordedRequest[],
): RecordedRequest[] {
  const out: RecordedRequest[] = [];
  for (const [index, request] of requests.entries()) {
    out.push(request);
    const previous = requests[index - 1];
    const name = request.path.slice(1);
    if (
      request.method === 'HEAD' &&
      previous?.path === `/_data_stream/${name}` &&
      item.cluster.exists?.[name] === true
    ) {
      out.push(previous);
    }
  }
  return out;
}

/**
 * A duplicate search's index list: each `name*` stops at the suffix
 * (`name-*`) and names the undated data stream too.
 */
function searchPath(path: string): string {
  const [indexes = '', ...rest] = path.slice(1).split('/');
  const list = indexes
    .split(',')
    .map(part => {
      const name = part.replace(TRAILING_WILDCARD, '');
      return `${name}-*,${name}`;
    })
    .join(',');
  return `/${[list, ...rest].join('/')}`;
}

/**
 * parsedmarc's recorded requests with tsdmarc's deviations applied (see
 * "Differences from parsedmarc"): duplicate searches stop at the suffix (`-*`)
 * and name the data stream, the save functions create indexes and data
 * stream templates with date mappings, the templates name tsdmarc, and the
 * legacy migration verifies the copy before deleting the original.
 */
export function withDeviations(
  item: SaveCase | OtherCase,
  requests: readonly RecordedRequest[],
): RecordedRequest[] {
  if (!('kind' in item)) {
    if (!ADDED_BEFORE_DELETE.test(item.name)) {
      return recheckStreams(item, requests).map(request =>
        request.path.startsWith('/_index_template/')
          ? tsdmarcTemplate(request)
          : request,
      );
    }
    const source = requests.at(-1)?.path ?? '';
    const copied: RecordedRequest[] = [
      { method: 'GET', path: `${source}-v2/_refresh` },
      { method: 'GET', path: `${source}/_count` },
      { method: 'GET', path: `${source}-v2/_count` },
    ];
    return [...requests.slice(0, -1), ...copied, ...requests.slice(-1)];
  }
  const mappings =
    INDEX_MAPPINGS[item.kind === 'smtp_tls' ? 'smtpTls' : item.kind];
  return recheckStreams(item, requests).map(request => {
    if (request.path.startsWith('/_index_template/')) {
      return tsdmarcTemplate(request, mappings);
    }
    if (request.method === 'PUT' && !request.path.startsWith('/_')) {
      return { ...request, body: { ...bodyObject(request), mappings } };
    }
    if (request.path.endsWith('/_search')) {
      return {
        ...request,
        path: searchPath(request.path),
        params: { ...request.params, ignore_unavailable: 'true' },
      };
    }
    return request;
  });
}

/** Put the fake cluster in a case's state. */
export function applyCluster(target: FakeCluster, state: ClusterState): void {
  target.reset();
  for (const [name, exists] of Object.entries(state.exists ?? {})) {
    if (exists) {
      target.existing.add(name);
    }
  }
  target.searchHits = state.search_hits ?? 0;
  target.count = state.count ?? 0;
  target.fieldMapping = state.field_mapping ?? null;
  target.scrollPages = structuredClone(state.scroll_pages ?? []);
  target.dataStreams = state.data_streams ?? null;
}
