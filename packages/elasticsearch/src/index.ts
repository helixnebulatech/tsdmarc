// Public API of @tsdmarc/elasticsearch (port of parsedmarc/elastic.py).

export { DOCUMENT_MAPPINGS } from '@tsdmarc/search-common/documents';
export type { DocumentMappings } from '@tsdmarc/search-common/documents';
export {
  AlreadySaved,
  BACKFILL,
  createClient,
  createDataStreams,
  createIndexes,
  ElasticsearchError,
  getDefaultConnection,
  getServerless,
  migrateIndexes,
  saveAggregateReportToElasticsearch,
  saveFailureReportToElasticsearch,
  saveForensicReportToElasticsearch,
  saveSmtpTlsReportToElasticsearch,
  setDefaultConnection,
  setHosts,
  setServerless,
} from './elastic';
export type {
  ConnectionOptions,
  MigrateIndexesOptions,
  SaveOptions,
  SetHostsOptions,
} from './elastic';
export { BulkIndexError, ScanError } from './reindex';
