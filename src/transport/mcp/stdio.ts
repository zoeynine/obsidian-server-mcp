import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

import {
  createVaultMcpServer,
  type VaultMcpServerDependencies,
} from "./server.js";

/** Serves the implemented Vault tools over the official MCP stdio entry. */
export function serveVaultMcpStdio(
  dependencies: VaultMcpServerDependencies,
  options: ServeStdioOptions = {},
): StdioServerHandle {
  return serveStdio(() => createVaultMcpServer(dependencies), options);
}
