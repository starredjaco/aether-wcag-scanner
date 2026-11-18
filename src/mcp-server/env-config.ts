/**
 * Clean up config values the MCP host handed us without filling them in.
 *
 * The plugin's .mcp.json passes AETHER_PLUGIN_API_KEY="${user_config.api_key}" (up to
 * 1.0.8 it was ALLCHEMY_API_KEY, and an older install may still pass that). When the
 * user never set the key (a terminal `claude plugin install` does not prompt for it),
 * Claude Code passes the value on in one of two ways:
 *   - as an empty string, or
 *   - as the literal, unsubstituted "${user_config.api_key}" text (seen in the
 *     insights-api logs on 2026-10-19 as "unknown key prefix=${user_c").
 * Either way the variable is present, so dotenv treats it as already set and never
 * reads the project's .env, and the placeholder is sent to the cloud as a key and
 * rejected with "Invalid API key". Treat both as unset.
 */

const PLACEHOLDER = /^\$\{[^}]*\}$/;

/** True for a value that is really "not configured": empty, or an unfilled ${...} placeholder. */
export function isUnsetConfigValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed === '' || PLACEHOLDER.test(trimmed);
}

/** Delete each named variable whose value is empty or an unfilled placeholder. */
export function clearUnsetConfigValues(names: string[], env: NodeJS.ProcessEnv = process.env): void {
  for (const name of names) {
    if (isUnsetConfigValue(env[name])) delete env[name];
  }
}

/**
 * The variable the plugin's .mcp.json fills from the `api_key` plugin option (#32).
 *
 * The option used to be mapped straight onto ALLCHEMY_API_KEY. That had two problems:
 *   - with the option unset, Claude Code flagged the server config as invalid
 *     ("Missing environment variables: user_config.api_key"; newer versions drop the
 *     server entirely), even when the key was set in the shell or settings.json `env`;
 *   - with `"default": ""` on the option (which removes that error), the empty value
 *     REPLACED an ALLCHEMY_API_KEY inherited from the shell or settings.json `env`.
 * Mapping to a separate name leaves the inherited ALLCHEMY_API_KEY alone; this module
 * then picks the winner.
 */
export const PLUGIN_API_KEY_VAR = 'AETHER_PLUGIN_API_KEY';

export const API_KEY_SOURCE_PLUGIN = 'plugin option';
export const API_KEY_SOURCE_ENV = 'environment (shell or settings.json env)';

/**
 * Resolve the API key from what the MCP host passed in, before any .env file is read.
 *
 * Precedence: plugin option (AETHER_PLUGIN_API_KEY) > inherited ALLCHEMY_API_KEY.
 * Empty values and unfilled ${...} placeholders count as unset. On return,
 * env.ALLCHEMY_API_KEY holds the winning key (or is absent, so dotenv can fill it from
 * a .env file) and AETHER_PLUGIN_API_KEY is removed so nothing else reads it.
 *
 * Returns the source label for the startup line, or '' when neither is set.
 */
export function resolveHostApiKey(env: NodeJS.ProcessEnv = process.env): string {
  clearUnsetConfigValues(['ALLCHEMY_API_KEY', PLUGIN_API_KEY_VAR], env);
  const fromPlugin = env[PLUGIN_API_KEY_VAR]?.trim();
  delete env[PLUGIN_API_KEY_VAR];
  if (fromPlugin) {
    env.ALLCHEMY_API_KEY = fromPlugin;
    return API_KEY_SOURCE_PLUGIN;
  }
  return env.ALLCHEMY_API_KEY ? API_KEY_SOURCE_ENV : '';
}
