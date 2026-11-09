// Public API of @tsdmarc/cli. Grouped by module; keep each group sorted.

export {
  archiveProcessedFile,
  archiveSubdirForResult,
  moveFileToArchive,
} from './archive';
export { createArgumentParser, parseArgs } from './args';
export {
  loadConfig,
  loadIndexPrefixDomainMap,
  normalizeGraphAuthMethod,
  parseConfig,
  strToList,
} from './config';
export type { IndexPrefixDomainMap } from './config';
export {
  ConfigParser,
  ConfigParserError,
  DuplicateOptionError,
  DuplicateSectionError,
  MissingSectionHeaderError,
  ParsingError,
  SectionProxy,
} from './configparser';
export {
  applyEnvOverrides,
  DIRECT_FILE_KEYS,
  KNOWN_SECTIONS,
  readSecretFile,
  resolveSectionKey,
} from './env';
export { ConfigurationError, SystemExit } from './errors';
export { configureDependencyLogging, configureLogging } from './logging';
export { main, run } from './main';
export { createOptions } from './options';
export type { CliArgs, CliOptions } from './options';
export {
  buildOutputClients,
  buildParserConfig,
  closeOutputClients,
  initOutputClients,
  migrationIndexNames,
  normalizeIndexPrefix,
} from './outputs';
export type { OutputClients } from './outputs';
export { expandFilePathArgs, expandPath, excludeArchivedPaths } from './paths';
export { processReports } from './process-reports';
export type { RunState } from './process-reports';
