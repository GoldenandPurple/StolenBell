#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { ToastRepository } from './data/repository.js';
import { createServer } from './server.js';
import { ToastClient, type ToastDataApi } from './toast/client.js';
import { DemoToastApi } from './toast/demo.js';
import { loadTipoutConfig } from './tipout/config.js';

async function main() {
  const config = loadConfig();
  const api: ToastDataApi = config.toast ? new ToastClient(config.toast) : new DemoToastApi();
  // Validate the tip-out config at startup so a typo fails loudly rather than at closing time.
  await loadTipoutConfig(config.tipoutConfigPath);
  const server = createServer({
    config,
    repo: new ToastRepository(api),
    loadTipoutConfig: () => loadTipoutConfig(config.tipoutConfigPath),
  });
  await server.connect(new StdioServerTransport());
  console.error(`toast-staff MCP server running on stdio (${config.mode} mode)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
