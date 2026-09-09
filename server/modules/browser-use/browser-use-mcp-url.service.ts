type BrowserUseMcpEnvironment = {
  [key: string]: string | undefined;
  CLOUDCLI_BROWSER_USE_API_URL?: string;
  HOST?: string;
  PORT?: string;
  SERVER_PORT?: string;
};

const BROWSER_USE_MCP_PATH = '/api/browser-use-mcp';

function readServerPort(environment: BrowserUseMcpEnvironment): string {
  const rawPort = (environment.SERVER_PORT || environment.PORT || '3001').trim();
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Invalid Browser MCP server port: "${rawPort}".`);
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Browser MCP server port: "${rawPort}".`);
  }
  return String(port);
}

function buildBoundBrowserUseMcpUrl(environment: BrowserUseMcpEnvironment): URL {
  const port = readServerPort(environment);
  const configuredHost = environment.HOST?.trim() || '0.0.0.0';
  const bindHost = configuredHost.startsWith('[') && configuredHost.endsWith(']')
    ? configuredHost.slice(1, -1)
    : configuredHost;
  const callbackHost = bindHost === '0.0.0.0'
    ? '127.0.0.1'
    : bindHost === '::' || bindHost === '0:0:0:0:0:0:0:0'
      ? '::1'
      : bindHost;
  const urlHost = callbackHost.includes(':') ? `[${callbackHost}]` : callbackHost;

  try {
    const url = new URL(`http://${urlHost}:${port}${BROWSER_USE_MCP_PATH}`);
    if (
      url.username !== ''
      || url.password !== ''
      || url.pathname !== BROWSER_USE_MCP_PATH
      || url.search !== ''
      || url.hash !== ''
    ) {
      throw new Error('Unsafe Browser MCP server host.');
    }
    return url;
  } catch {
    throw new Error(`Invalid Browser MCP server host: "${configuredHost}".`);
  }
}

function validateConfiguredBrowserUseMcpUrl(configuredValue: string, boundUrl: URL): URL {
  let configuredUrl: URL;
  try {
    configuredUrl = new URL(configuredValue);
  } catch {
    throw new Error('CLOUDCLI_BROWSER_USE_API_URL must be an absolute URL.');
  }

  const normalizedPath = configuredUrl.pathname.replace(/\/+$/, '') || '/';
  const isExactBridgeUrl = configuredUrl.origin === boundUrl.origin
    && normalizedPath === BROWSER_USE_MCP_PATH
    && configuredUrl.username === ''
    && configuredUrl.password === ''
    && configuredUrl.search === ''
    && configuredUrl.hash === '';

  if (!isExactBridgeUrl) {
    throw new Error(
      'CLOUDCLI_BROWSER_USE_API_URL must use the CloudCLI server origin and exact Browser MCP path.',
    );
  }

  configuredUrl.pathname = BROWSER_USE_MCP_PATH;
  return configuredUrl;
}

/**
 * Builds the callback endpoint that Browser Use passes to its local MCP child.
 * The Browser Use service uses the concrete server binding when loopback is not
 * listening, while wildcard bindings are converted to a reachable loopback.
 */
export function resolveBrowserUseMcpApiUrl(
  environment: BrowserUseMcpEnvironment = process.env,
): string {
  const boundUrl = buildBoundBrowserUseMcpUrl(environment);
  const configuredApiUrl = environment.CLOUDCLI_BROWSER_USE_API_URL?.trim();
  if (configuredApiUrl) {
    return validateConfiguredBrowserUseMcpUrl(configuredApiUrl, boundUrl).toString().replace(/\/+$/, '');
  }

  return boundUrl.toString().replace(/\/+$/, '');
}
