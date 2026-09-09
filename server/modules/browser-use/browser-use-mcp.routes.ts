import express, {
  type Express,
  type RequestHandler,
  type Router,
} from 'express';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';
import {
  captureDeploymentPolicy,
  createDeploymentPolicyMiddleware,
  DEPLOYMENT_CAPABILITIES,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import {
  extractBearerToken,
  extractBearerTokenFromQuery,
} from '@/shared/bearer-token.js';

function readBridgeToken(value: unknown): string | null {
  return extractBearerTokenFromQuery(value);
}

type BrowserUseMcpTokenSource = Pick<typeof browserUseService, 'getMcpToken'>
  & Partial<Pick<typeof browserUseService, 'getExistingMcpToken'>>;

/** Browser service methods consumed by the MCP transport. */
export type BrowserUseMcpService = Pick<
  typeof browserUseService,
  | 'createAgentSession'
  | 'listAgentSessions'
  | 'agentSnapshot'
  | 'agentNavigate'
  | 'agentClick'
  | 'agentType'
  | 'agentFillForm'
  | 'agentPressKey'
  | 'agentSelectOption'
  | 'agentWaitFor'
  | 'agentTabs'
  | 'agentStopSession'
>;

export type BrowserUseMcpRouterOptions = {
  tokenSource?: BrowserUseMcpTokenSource;
  service?: BrowserUseMcpService;
  /** Optional deployment capability factory supplied by the composition root. */
  capabilityGuard?: (operation: string) => RequestHandler;
  /** Startup deployment policy used when this router is mounted standalone. */
  deploymentPolicy?: DeploymentPolicySource;
};

/**
 * Builds the dedicated bearer-token guard used by the Browser MCP router.
 * The production router and its boundary tests share this factory so bypassing
 * the installation API key never bypasses Browser MCP authentication.
 */
export function createBrowserUseMcpTokenGuard(
  tokenSource: BrowserUseMcpTokenSource = browserUseService,
): RequestHandler {
  return (req, res, next) => {
    // Authentication probes must not create or persist a token.  In the
    // production service the non-mutating accessor returns null until Browser
    // MCP has been explicitly enabled/registered; lightweight test/legacy
    // token sources may expose only getMcpToken and retain the old contract.
    const expected = tokenSource.getExistingMcpToken
      ? tokenSource.getExistingMcpToken()
      : tokenSource.getMcpToken();
    const rawAuthorization = req.headers.authorization;
    const rawCustomToken = req.headers['x-browser-use-mcp-token'];
    const hasAuthorizationHeader = rawAuthorization !== undefined;
    const hasCustomTokenHeader = rawCustomToken !== undefined;
    // Treat multiple credential channels as ambiguous. In particular, a
    // malformed Authorization header must not fall back to a valid custom
    // header, otherwise a proxy can accidentally turn an invalid request into
    // an authenticated Browser MCP call. Arrays are rejected by the shared
    // parser as well, matching the REST/WebSocket auth contract.
    const token = hasAuthorizationHeader || hasCustomTokenHeader
      ? (hasAuthorizationHeader && hasCustomTokenHeader
        ? null
        : hasAuthorizationHeader
          ? extractBearerToken(rawAuthorization)
          : readBridgeToken(rawCustomToken))
      : null;
    if (!token || token !== expected) {
      res.status(401).json({ success: false, error: 'Invalid Browser MCP token.' });
      return;
    }
    next();
  };
}

/**
 * Browser MCP is a token-authenticated internal bridge rather than a browser
 * JWT route.  Consequently its deployment boundary must be enforced here,
 * after the bridge token and before any Browser service call.  Read-only tools
 * (listing/snapshot/waiting and non-destructive tab inspection) remain usable
 * in the product/QA profile; navigation, input, session creation/closure and
 * destructive tab actions require `browser.use`.
 */
function capabilityForBrowserTool(request: express.Request): string {
  const toolName = request.params.toolName;
  if (toolName === 'browser_list_sessions'
    || toolName === 'browser_snapshot'
    || toolName === 'browser_take_screenshot'
    || toolName === 'browser_wait_for') {
    return DEPLOYMENT_CAPABILITIES.BROWSER_READ;
  }
  if (toolName === 'browser_tabs') {
    const body = request.body && typeof request.body === 'object'
      ? request.body as Record<string, unknown>
      : {};
    const action = body.action;
    // `select` changes the shared agent handle's active page and therefore
    // affects subsequent callers; only listing tabs is a read operation.
    if (action === undefined || action === 'list') {
      return DEPLOYMENT_CAPABILITIES.BROWSER_READ;
    }
  }
  return DEPLOYMENT_CAPABILITIES.BROWSER_USE;
}

/** Creates a token-protected, optionally policy-aware Browser MCP router. */
export function createBrowserUseMcpRouter(
  options: BrowserUseMcpRouterOptions = {},
): Router {
  const router = express.Router();
  const service = options.service ?? browserUseService;
  router.use(createBrowserUseMcpTokenGuard(options.tokenSource ?? browserUseService));
  // A caller that mounts this router outside the main composition root still
  // receives the startup policy boundary. Production injects its immutable
  // policy guard; the fallback prevents a token-only bridge from re-enabling
  // Browser side effects in a product/QA deployment. Capture the fallback once
  // at construction time: re-reading process.env for every request would let a
  // mutable environment (or test harness) drift the authorization boundary.
  const fallbackPolicy = captureDeploymentPolicy(options.deploymentPolicy);
  const capabilityGuard = options.capabilityGuard
    ?? ((operation: string) => createDeploymentPolicyMiddleware({
      policy: fallbackPolicy,
      capability: operation,
    }));
  // The bridge is mounted before the app-wide JSON parser so its dedicated
  // bearer token can bypass the installation API key. Parse tool bodies here
  // as well; otherwise `browser_tabs { action: "new" }` appears body-less to
  // the capability classifier and could be misclassified as a read operation.
  router.use(express.json({ limit: '50mb' }));
  router.use('/tools/:toolName', (req, res, next) => {
    capabilityGuard(capabilityForBrowserTool(req))(req, res, next);
  });

router.post('/tools/:toolName', async (req, res) => {
  try {
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const toolName = req.params.toolName;
    let result: unknown;

    switch (toolName) {
      case 'browser_create_session':
        result = await service.createAgentSession({
          profileName: typeof input.profileName === 'string' ? input.profileName : null,
        });
        break;
      case 'browser_list_sessions':
        result = await service.listAgentSessions();
        break;
      case 'browser_snapshot':
      case 'browser_take_screenshot':
        result = await service.agentSnapshot(sessionId);
        break;
      case 'browser_navigate':
        result = await service.agentNavigate(sessionId, String(input.url || ''));
        break;
      case 'browser_click':
        result = await service.agentClick(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          text: typeof input.text === 'string' ? input.text : undefined,
          x: typeof input.x === 'number' ? input.x : undefined,
          y: typeof input.y === 'number' ? input.y : undefined,
        });
        break;
      case 'browser_type':
        result = await service.agentType(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          text: String(input.text || ''),
          submit: input.submit === true,
        });
        break;
      case 'browser_fill_form':
        result = await service.agentFillForm(
          sessionId,
          Array.isArray(input.fields)
            ? input.fields.map((field) => {
              const record = field as Record<string, unknown>;
              return {
                selector: String(record.selector || ''),
                value: String(record.value || ''),
              };
            })
            : [],
        );
        break;
      case 'browser_press_key':
        result = await service.agentPressKey(sessionId, String(input.key || ''));
        break;
      case 'browser_select_option':
        result = await service.agentSelectOption(
          sessionId,
          String(input.selector || ''),
          Array.isArray(input.values) ? input.values.filter((value): value is string => typeof value === 'string') : [],
        );
        break;
      case 'browser_wait_for':
        result = await service.agentWaitFor(sessionId, {
          text: typeof input.text === 'string' ? input.text : undefined,
          url: typeof input.url === 'string' ? input.url : undefined,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
        });
        break;
      case 'browser_tabs':
        result = await service.agentTabs(sessionId, {
          action: input.action === 'new' || input.action === 'select' || input.action === 'close' || input.action === 'list'
            ? input.action
            : undefined,
          index: typeof input.index === 'number' ? input.index : undefined,
          url: typeof input.url === 'string' ? input.url : undefined,
        });
        break;
      case 'browser_close_session':
        result = await service.agentStopSession(sessionId);
        break;
      default:
        res.status(404).json({ success: false, error: `Unknown Browser MCP tool "${toolName}".` });
        return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Browser MCP tool failed.',
    });
  }
  });
  return router;
}

const router = createBrowserUseMcpRouter();

/**
 * Mounts the token-protected Browser MCP callback ahead of the optional
 * installation-wide API key. The stdio MCP child owns only its dedicated
 * Browser token, so it must not be coupled to a separately configured API_KEY.
 * The server composition root is the production consumer of this ordering.
 */
export function mountBrowserUseMcpBridgeBeforeApiKey(
  app: Express,
  installationApiKeyGuard: RequestHandler,
  bridgeRoutes: Router = router,
): void {
  app.use('/api/browser-use-mcp', bridgeRoutes);
  app.use('/api', installationApiKeyGuard);
}

export default router;
