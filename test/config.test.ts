import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_TIPOUT_CONFIG_PATH, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('finds the tip-out config in the install folder, not the current folder', () => {
    expect(loadConfig({}).tipoutConfigPath).toBe(DEFAULT_TIPOUT_CONFIG_PATH);
    expect(existsSync(DEFAULT_TIPOUT_CONFIG_PATH)).toBe(true);
  });

  it('requires all live credentials', () => {
    expect(() => loadConfig({ TOAST_MCP_MODE: 'live', TOAST_CLIENT_ID: 'x' })).toThrow(ConfigError);
  });

  it('accepts a full live configuration and trims a trailing slash', () => {
    const config = loadConfig({
      TOAST_MCP_MODE: 'live',
      TOAST_API_ACCESS_URL: 'https://ws-api.toasttab.com/',
      TOAST_CLIENT_ID: 'id',
      TOAST_CLIENT_SECRET: 'secret',
      TOAST_RESTAURANT_GUID: 'guid',
    });
    expect(config.toast?.accessUrl).toBe('https://ws-api.toasttab.com');
  });
});
