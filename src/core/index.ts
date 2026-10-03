export {
  DEFAULT_MAX_VAULT_DOCUMENT_BYTES,
  MAX_VAULT_DOCUMENT_BYTES,
  InvalidVaultDocumentEncodingError,
  InvalidVaultDocumentReadLimitError,
  VaultDocumentChangedDuringReadError,
  VaultDocumentNotFoundError,
  VaultDocumentNotRegularFileError,
  VaultDocumentReadError,
  VaultDocumentTooLargeError,
  readVaultDocument,
  readVaultFileBytes,
  inspectVaultFile,
  type VaultFileInfo,
  type VaultFileBytes,
  type ReadVaultDocumentOptions,
  type VaultDocumentReadErrorCode,
  type VaultDocumentReadResult,
  type VaultEntryType,
} from "./file/read-vault-document.js";

export {
  getVaultDocumentMap,
  type GetVaultDocumentMapOptions,
  type VaultDocumentMapResult,
  type VaultDocumentReader,
} from "./document/get-vault-document-map.js";

export {
  DEFAULT_MAX_VAULT_LIST_ENTRIES,
  MAX_VAULT_LIST_ENTRIES,
  InvalidVaultListLimitError,
  VaultDirectoryChangedDuringListError,
  VaultDirectoryNotFoundError,
  VaultDirectoryTooLargeError,
  VaultEntryNameNotRepresentableError,
  VaultListError,
  VaultListNotDirectoryError,
  listVaultEntries,
  listVaultFiles,
  type ListVaultEntriesOptions,
  type VaultListEntry,
  type VaultListEntryKind,
  type VaultListErrorCode,
  type VaultListResult,
} from "./list/list-vault-entries.js";

export {
  VaultPathError,
  VaultPathSandbox,
  parseVaultRelativePath,
  type ParseVaultPathOptions,
  type ResolvedVaultPath,
  type ResolveVaultPathOptions,
  type VaultPathErrorCode,
  type VaultRelativePath,
} from "./path/vault-path.js";

export {
  DEFAULT_MAX_DOCUMENT_MAP_HEADINGS,
  MAX_DOCUMENT_MAP_HEADINGS,
  InvalidDocumentMapHeadingLimitError,
  MarkdownDocumentMapError,
  MarkdownDocumentMapTooLargeError,
  type MarkdownDocumentMapErrorCode,
  type DocumentMapLimitOptions,
} from "./document/document-map-limits.js";

export {
  InvalidContentVersionError,
  VersionConflictError,
  assertVersionMatch,
  computeContentVersion,
  parseContentVersion,
  type ContentVersion,
} from "./version/content-version.js";

export { extractDocumentTags } from "./tag/extract-document-tags.js";

export { readVaultNote, type ReadVaultNoteOptions, type VaultNoteReadResult } from "./document/read-vault-note.js";
export { toNoteJson, VaultSemanticError, type NoteJson, type JsonValue } from "./document/note-json.js";
export { prepareVaultPatch, type VaultPatchInstruction } from "./patch/prepare-vault-patch.js";
export { VaultTextError, assertTextContent, assertTextPath } from "./file/text-policy.js";
export { VaultMutationStore, VaultMutationError, type VaultMutationOptions,
  type VaultMutationResult, type VaultMutationErrorCode } from "./mutation/vault-mutations.js";
export { nativeMutationIO, type MutationIO } from "./mutation/mutation-io.js";
export { type VaultMoveOptions, type VaultMoveResult, type VaultDeleteOptions, type VaultDeleteResult } from "./mutation/file-operations.js";

export {
  DEFAULT_TAG_LIST_MAX_ENTRIES,
  DEFAULT_TAG_LIST_MAX_FILES,
  DEFAULT_TAG_LIST_MAX_FILE_BYTES,
  DEFAULT_TAG_LIST_MAX_TAGS,
  DEFAULT_TAG_LIST_MAX_TOTAL_BYTES,
  MAX_TAG_LIST_ENTRIES,
  MAX_TAG_LIST_FILES,
  MAX_TAG_LIST_FILE_BYTES,
  MAX_TAG_LIST_TAGS,
  MAX_TAG_LIST_TOTAL_BYTES,
  InvalidVaultTagListOptionError,
  VaultTagListBudgetExceededError,
  VaultTagListError,
  VaultTagListSourceUnavailableError,
  VaultTagListTraversalChangedError,
  VaultTagListTraversalUnavailableError,
  VaultTagListUnsafeEntryNameError,
  listVaultTags,
  type ListVaultTagsOptions,
  type ListVaultTagsResult,
  type TagListBudgetName,
  type TagListOptionName,
  type VaultTagCount,
  type VaultTagListErrorCode,
} from "./tag/list-vault-tags.js";

export {
  DEFAULT_SEARCH_QUERY_MAX_ENTRIES,
  DEFAULT_SEARCH_QUERY_MAX_FILE_BYTES,
  DEFAULT_SEARCH_QUERY_MAX_FILES,
  DEFAULT_SEARCH_QUERY_MAX_RESULTS,
  DEFAULT_SEARCH_QUERY_MAX_TOTAL_BYTES,
  MAX_SEARCH_QUERY_AST_NODES,
  MAX_SEARCH_QUERY_DEPTH,
  MAX_SEARCH_QUERY_ENTRIES,
  MAX_SEARCH_QUERY_FILE_BYTES,
  MAX_SEARCH_QUERY_FILES,
  MAX_SEARCH_QUERY_RESULTS,
  MAX_SEARCH_QUERY_SERIALIZED_BYTES,
  MAX_SEARCH_QUERY_STRING_LENGTH,
  MAX_SEARCH_QUERY_TOTAL_BYTES,
  InvalidVaultSearchQueryError,
  InvalidVaultSearchQueryOptionError,
  VaultSearchQueryBudgetExceededError,
  VaultSearchQueryError,
  VaultSearchQuerySourceUnavailableError,
  VaultSearchQueryTraversalChangedError,
  VaultSearchQueryTraversalUnavailableError,
  VaultSearchQueryUnsafeEntryNameError,
  searchVaultQuery,
  type SearchQueryBudgetName,
  type SearchQueryInvalidReason,
  type SearchQueryOptionName,
  type SearchVaultQueryResultEntry,
  type SearchVaultQueryOptions,
  type VaultSearchQueryErrorCode,
} from "./search/search-vault-query.js";

export * from "./binary/read-vault-binary.js";
export { MAX_SEARCH_QUERY_OUTPUT_BYTES } from "./search/query-limits.js";
export * from "./reference/types.js";
export { queryReferences } from "./reference/query-references.js";
