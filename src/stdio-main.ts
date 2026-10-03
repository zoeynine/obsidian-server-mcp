#!/usr/bin/env node

import {
  VaultPathSandbox,
  getVaultDocumentMap,
  listVaultFiles,
  listVaultTags,
  readVaultDocument,
  readVaultBinary,
  searchVaultQuery,
  queryReferences,
  type ReadVaultDocumentOptions,
} from "./core/index.js";
import { readVaultNote } from "./core/document/read-vault-note.js";
import { VaultMutationStore } from "./core/mutation/vault-mutations.js";
import { serveVaultMcpStdio } from "./transport/mcp/stdio.js";

const vaultRoot = process.env["OBSIDIAN_VAULT_ROOT"];

if (vaultRoot === undefined || vaultRoot.length === 0) {
  console.error("OBSIDIAN_VAULT_ROOT is required");
  process.exitCode = 1;
} else {
  try {
    const sandbox = await VaultPathSandbox.create(vaultRoot);
    const mutations = await VaultMutationStore.create(sandbox);
    const readDocument = (
      inputPath: string,
      options?: ReadVaultDocumentOptions,
    ) => readVaultDocument(sandbox, inputPath, options);
    const handle = serveVaultMcpStdio(
      {
        getDocumentMap: (inputPath, options) =>
          getVaultDocumentMap(readDocument, inputPath, options),
        listEntries: (inputPath, options) =>
          listVaultFiles(sandbox, inputPath, options),
        readDocument: (inputPath, options) => readVaultNote(readDocument, inputPath, options),
        searchQuery: (query, options) =>
          searchVaultQuery(sandbox, readDocument, query, options),
        tagList: (options) => listVaultTags(sandbox, readDocument, options),
        referenceQuery: (input) => queryReferences(sandbox, readDocument, input),
        mutations,
        readBinary: (inputPath, options) => readVaultBinary(sandbox, inputPath, options),
      },
      {
        onerror: (error) => {
          console.error(`MCP transport error: ${error.message}`);
        },
      },
    );

    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void handle.close().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`MCP shutdown error: ${message}`);
        process.exitCode = 1;
      });
    };

    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Failed to start Obsidian Server MCP: ${message}`);
    process.exitCode = 1;
  }
}
