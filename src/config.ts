export type Mode = 'demo' | 'live';

export interface AppConfig {
  mode: Mode;
  includeWages: boolean;
  tipoutConfigPath: string;
  toast?: {
    accessUrl: string;
    clientId: string;
    clientSecret: string;
    restaurantGuid: string;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.TOAST_MCP_MODE ?? 'demo').toLowerCase();
  if (mode !== 'demo' && mode !== 'live') {
    throw new ConfigError(`TOAST_MCP_MODE must be "demo" or "live", got "${mode}"`);
  }
  const config: AppConfig = {
    mode,
    includeWages: env.TOAST_INCLUDE_WAGES?.toLowerCase() === 'true',
    tipoutConfigPath: env.TIPOUT_CONFIG_PATH || 'config/tipout.yaml',
  };
  if (mode === 'demo') return config;

  const required = ['TOAST_API_ACCESS_URL', 'TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ConfigError(`Live mode requires ${missing.join(', ')}`);
  }
  const accessUrl = env.TOAST_API_ACCESS_URL!.replace(/\/+$/, '');
  if (!/^https:\/\//.test(accessUrl)) {
    throw new ConfigError('TOAST_API_ACCESS_URL must be an https:// URL');
  }
  config.toast = {
    accessUrl,
    clientId: env.TOAST_CLIENT_ID!,
    clientSecret: env.TOAST_CLIENT_SECRET!,
    restaurantGuid: env.TOAST_RESTAURANT_GUID!,
  };
  return config;
}
