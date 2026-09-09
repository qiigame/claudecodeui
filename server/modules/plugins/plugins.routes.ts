import fs from 'node:fs';
import http from 'node:http';

import express from 'express';

import {
  captureDeploymentPolicy,
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  hasPluginExecutionCapability,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { AppError } from '@/shared/utils.js';

import type { createPluginsService } from './plugins.service.js';

function wildcardPath(req: express.Request): string {
  return ((req.params as Record<string, string>)['0'] ?? '').trim();
}

function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function proxyQuery(requestUrl: string, authorizedProjectPath?: string): string {
  const queryIndex = requestUrl.indexOf('?');
  const rawQuery = queryIndex >= 0 ? requestUrl.slice(queryIndex + 1) : '';
  if (!authorizedProjectPath) {
    return rawQuery ? `?${rawQuery}` : '';
  }

  const searchParams = new URLSearchParams(rawQuery);
  searchParams.delete('path');
  searchParams.set('path', authorizedProjectPath);
  return `?${searchParams.toString()}`;
}

/** Creates plugin routes; transport streaming remains here while decisions live in the service. */
export type PluginsRouterOptions = {
  /** Optional policy override used by composition roots and deterministic tests. */
  deploymentPolicy?: DeploymentPolicy | (() => DeploymentPolicy);
  /**
   * Optional managed-identity assertion supplied by the production module.
   * Plugin RPC is execution even when transported over GET, so HTTP method
   * based auth middleware alone cannot protect pending/ambiguous actors.
   */
  assertActorCanUsePlugins?: (request: express.Request) => void;
};

type DeploymentPolicyRequest = express.Request & { deploymentPolicy?: DeploymentPolicy };

const PLUGIN_MANAGEMENT_CAPABILITIES = [
  DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE,
] as const;

const PRODUCT_QA_READ_ONLY_PLUGIN_RPC_PATHS = new Map<string, ReadonlySet<string>>([
  ['comic-coordination', new Set(['flow', 'tree', 'file'])],
]);

function isProductQaReadOnlyPluginRpc(
  request: express.Request,
  policy: DeploymentPolicy,
): boolean {
  if (policy.profile !== 'product-qa-readonly'
    || request.method !== 'GET'
    || !hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PLUGIN_READ)) {
    return false;
  }
  const pluginName = routeParameter(request.params.name);
  return PRODUCT_QA_READ_ONLY_PLUGIN_RPC_PATHS.get(pluginName)?.has(wildcardPath(request)) === true;
}

// `plugin.write` is retained as a compatibility execution grant for existing
// developer installs. New deployments can grant only `plugin.use`, which
// permits RPC execution without allowing install/update/enable/uninstall.
export function createPluginsRouter(
  service: ReturnType<typeof createPluginsService>,
  options: PluginsRouterOptions = {},
): express.Router {
  const router = express.Router();
  // Resolve a function/object source once at router construction.  The
  // authenticated composition middleware can still provide a trusted
  // request snapshot, but an alternate mount never re-reads process.env per
  // request after startup.
  const startupDeploymentPolicy = captureDeploymentPolicy(options.deploymentPolicy);
  const resolveDeploymentPolicy = (request: express.Request): DeploymentPolicy => {
    return (request as DeploymentPolicyRequest).deploymentPolicy ?? startupDeploymentPolicy;
  };
  const createCapabilityGuard = (
    capabilities: readonly string[],
    message: string,
  ): express.RequestHandler => (request, _response, next) => {
    const policy = resolveDeploymentPolicy(request);
    const allowed = policy.profile !== 'product-qa-readonly'
      && capabilities.some((capability) => hasDeploymentCapability(policy, capability));
    if (!allowed) {
      next(new AppError(message, {
        code: 'DEPLOYMENT_CAPABILITY_DENIED',
        statusCode: 403,
        details: { profile: policy.profile, capabilities },
      }));
      return;
    }
    next();
  };
  const pluginWriteGuard = createCapabilityGuard(
    PLUGIN_MANAGEMENT_CAPABILITIES,
    'Plugin management is disabled for this deployment.',
  );
  // Installing, updating, enabling, or removing a plugin is itself an
  // execution/configuration side effect.  A standalone managed (for example,
  // writable `developer` + DingTalk SSO) mount may not have the application
  // index's outer settings guard, so reuse the same verified-actor callback
  // here as the RPC path.  The callback is optional to preserve ordinary
  // local/developer and legacy test compositions.
  const pluginManagementGuard: express.RequestHandler = (request, response, next) => {
    pluginWriteGuard(request, response, (guardError?: unknown) => {
      if (guardError) {
        next(guardError);
        return;
      }
      try {
        options.assertActorCanUsePlugins?.(request);
        next();
      } catch (error) {
        next(error);
      }
    });
  };
  const pluginUseGuard: express.RequestHandler = (request, _response, next) => {
    const policy = resolveDeploymentPolicy(request);
    // RPC execution has a dedicated helper so HTTP, WebSocket, and startup
    // paths all recognize the same least-privilege `plugin.use` grant and the
    // legacy `plugin.write` compatibility grant.
    if (policy.profile === 'product-qa-readonly' || !hasPluginExecutionCapability(policy)) {
      next(new AppError('Plugin RPC is disabled for this deployment.', {
        code: 'DEPLOYMENT_CAPABILITY_DENIED',
        statusCode: 403,
        details: {
          profile: policy.profile,
          capabilities: [DEPLOYMENT_CAPABILITIES.PLUGIN_USE, DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE],
        },
      }));
      return;
    }
    try {
      options.assertActorCanUsePlugins?.(request);
      next();
    } catch (error) {
      next(error);
    }
  };
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json(await operation(req)); } catch (error) { next(error); }
    };

  router.get('/', respond(() => service.list()));
  router.get('/:name/manifest', respond((req) => service.getManifest(routeParameter(req.params.name))));
  router.get('/:name/assets/*', async (req, res, next) => {
    try {
      const asset = service.resolveAsset(routeParameter(req.params.name), wildcardPath(req));
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const stream = fs.createReadStream(asset.path);
      stream.on('error', next);
      stream.pipe(res);
    } catch (error) { next(error); }
  });
  router.put('/:name/enable', pluginManagementGuard, respond((req) => service.setEnabled(routeParameter(req.params.name), req.body?.enabled)));
  router.post('/install', pluginManagementGuard, respond((req) => service.install(req.body?.url)));
  router.post('/:name/update', pluginManagementGuard, respond((req) => service.update(routeParameter(req.params.name))));
  router.all('/:name/rpc/*', async (req, res, next) => {
    try {
      const policy = resolveDeploymentPolicy(req);
      if (isProductQaReadOnlyPluginRpc(req, policy)) {
        // The project-coordination mirror is an operator-installed, GET-only
        // adapter over the loopback 3084 read service. It remains available to
        // authenticated pending actors without forwarding plugin secrets or
        // opening generic third-party plugin execution in product/QA.
        void proxyPluginRpc(req, res, next, service, undefined, false);
        return;
      }
      // RPC is intentionally guarded for every HTTP method. Even a GET can
      // trigger plugin-side work, and product/QA deployments do not expose
      // plugin execution as an implicit capability.
      pluginUseGuard(req, res, (guardError) => {
        if (guardError) {
          next(guardError);
          return;
        }
        void proxyPluginRpc(req, res, next, service, options.assertActorCanUsePlugins);
      });
    } catch (error) { next(error); }
  });
  router.delete('/:name', pluginManagementGuard, respond((req) => service.uninstall(routeParameter(req.params.name))));
  return router;
}

/** Proxies one authorized plugin RPC request to its local plugin process. */
async function proxyPluginRpc(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  service: ReturnType<typeof createPluginsService>,
  assertActorCanUsePlugins?: (request: express.Request) => void,
  forwardSecrets = true,
): Promise<void> {
    try {
      const prepared = await service.prepareRpc(
        routeParameter(req.params.name),
        req.query.path,
      );
      // `prepareRpc` may await plugin startup. Revalidate after that await and
      // immediately before opening the proxy request so a revoked managed
      // actor cannot turn an already-admitted request into plugin execution.
      try {
        assertActorCanUsePlugins?.(req);
      } catch (error) {
        // If this request implicitly started a plugin, do not leave arbitrary
        // third-party code running after the managed actor lost execution
        // authority while startup was awaiting.  Already-running plugins are
        // shared process resources and are deliberately left untouched.
        if (prepared.startedByRequest === true) {
          await service.stopServer(routeParameter(req.params.name)).catch((cleanupError) => {
            // Cleanup is best effort; preserve the identity error as the
            // response contract while making the failure observable to the
            // server operator without echoing it to the client.
            console.error('[Plugins] Failed to stop plugin after actor revocation:', cleanupError);
          });
        }
        throw error;
      }
      const { port, secrets, authorizedProjectPath } = prepared;
      const headers: Record<string, string> = {
        'content-type': String(req.headers['content-type'] ?? 'application/json'),
      };
      if (forwardSecrets) {
        for (const [key, value] of Object.entries(secrets)) {
          headers[`x-plugin-secret-${key.toLowerCase()}`] = String(value);
        }
      }
      // Project Stats receives the canonical DB-authorized path, never the raw
      // query spelling that was normalized for the allowlist comparison.
      const query = proxyQuery(req.url, authorizedProjectPath);
      const proxyRequest = http.request({
        hostname: '127.0.0.1', port, path: `/${wildcardPath(req)}${query}`, method: req.method, headers,
      }, (proxyResponse) => {
        res.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(res);
      });
      proxyRequest.on('error', next);
      if (req.headers['content-length'] && req.body !== undefined) {
        const body = JSON.stringify(req.body);
        proxyRequest.setHeader('content-length', Buffer.byteLength(body));
        proxyRequest.write(body);
      }
      proxyRequest.end();
    } catch (error) { next(error); }
}
