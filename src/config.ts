/**
 * Bridge configuration loader.
 * 
 * Reads config from environment variables and/or a config.json file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BridgeConfig {
  // Matrix / Appservice
  appservice: {
    port: number;
    hsToken: string;
    asToken: string;
    homeserverUrl: string;
    botUserId: string;
    userId: string;
    userAccessToken: string;
    userPrefix: string;
    userSuffix: string;
  };
  // Threema
  threema: {
    dataDir: string;
  };
  // Bridge state persistence
  stateDir: string;
}

export function loadConfig(configPath?: string): BridgeConfig {
  const resolvedPath = configPath ?? path.resolve(process.cwd(), 'config.json');
  
  let fileConfig: Partial<Record<string, unknown>> = {};
  if (fs.existsSync(resolvedPath)) {
    fileConfig = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  }

  // Registration file for hs_token / as_token
  const registrationPath = process.env.BRIDGE_REGISTRATION_FILE
    ?? (fileConfig.registration_file as string | undefined)
    ?? path.resolve(process.cwd(), 'registration.yaml');

  let hsToken = process.env.BRIDGE_HS_TOKEN ?? '';
  let asToken = process.env.BRIDGE_AS_TOKEN ?? '';

  if ((!hsToken || !asToken) && fs.existsSync(registrationPath)) {
    const regContent = fs.readFileSync(registrationPath, 'utf-8');
    if (!hsToken) {
      const match = regContent.match(/hs_token:\s*["']?([^"'\n]+)/);
      if (match) hsToken = match[1].trim();
    }
    if (!asToken) {
      const match = regContent.match(/as_token:\s*["']?([^"'\n]+)/);
      if (match) asToken = match[1].trim();
    }
  }

  const port = Number(process.env.BRIDGE_PORT ?? (fileConfig.port as number | undefined) ?? 29318);
  const homeserverUrl = process.env.BRIDGE_HOMESERVER_URL
    ?? (fileConfig.homeserver_url as string | undefined)
    ?? 'https://matrix.beeper.com/_hungryserv/ccarpo';

  const botUserId = process.env.BRIDGE_BOT_USER_ID
    ?? (fileConfig.bot_user_id as string | undefined)
    ?? '@sh-threemabot:beeper.local';

  const userPrefix = process.env.BRIDGE_USER_PREFIX
    ?? (fileConfig.user_prefix as string | undefined)
    ?? '@sh-threema_';

  const userSuffix = process.env.BRIDGE_USER_SUFFIX
    ?? (fileConfig.user_suffix as string | undefined)
    ?? ':beeper.local';

  const userId = process.env.BRIDGE_USER_ID
    ?? (fileConfig.user_id as string | undefined)
    ?? '@ccarpo:beeper.com';

  // Load user access token from bbctl config or env
  let userAccessToken = process.env.BRIDGE_USER_ACCESS_TOKEN
    ?? (fileConfig.user_access_token as string | undefined)
    ?? '';
  if (!userAccessToken) {
    // Try to load from bbctl config
    const bbctlConfigPath = path.resolve(process.env.HOME ?? '', '.config/bbctl/config.json');
    if (fs.existsSync(bbctlConfigPath)) {
      try {
        const bbctlConfig = JSON.parse(fs.readFileSync(bbctlConfigPath, 'utf-8'));
        userAccessToken = bbctlConfig?.environments?.prod?.access_token ?? '';
      } catch { /* ignore */ }
    }
  }

  const dataDir = process.env.THREEMA_DATA_DIR
    ?? (fileConfig.threema_data_dir as string | undefined)
    ?? path.resolve(process.cwd(), 'data');

  const stateDir = process.env.BRIDGE_STATE_DIR
    ?? (fileConfig.state_dir as string | undefined)
    ?? path.resolve(process.cwd(), 'state');

  return {
    appservice: {
      port,
      hsToken,
      asToken,
      homeserverUrl,
      botUserId,
      userId,
      userAccessToken,
      userPrefix,
      userSuffix,
    },
    threema: {
      dataDir,
    },
    stateDir,
  };
}
