// Public API of @tsdmarc/opensearch (port of parsedmarc/opensearch.py).

export {
  DOCUMENT_MAPPINGS,
  type DocumentMappings,
} from '@tsdmarc/search-common/documents';
export {
  AlreadySaved,
  BACKFILL,
  createClient,
  createDataStreams,
  createIndexes,
  getDefaultConnection,
  migrateIndexes,
  OpenSearchError,
  saveAggregateReportToOpenSearch,
  saveFailureReportToOpenSearch,
  saveForensicReportToOpenSearch,
  saveSmtpTlsReportToOpenSearch,
  setDefaultConnection,
  setHosts,
  type ConnectionOptions,
  type MigrateIndexesOptions,
  type SaveOptions,
  type SetHostsOptions,
} from './opensearch';
export { BulkIndexError, ScanError } from './reindex';
