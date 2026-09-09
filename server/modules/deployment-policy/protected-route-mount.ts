import type { Application, RequestHandler } from 'express';

/**
 * Mounts one authenticated API feature at the same boundary used by the
 * production composition root.  Authentication is deliberately the first
 * middleware, capability guards run next, and the feature router is last so a
 * denied request cannot reach its handler or any filesystem/subprocess side
 * effect.
 *
 * The small helper is exported for the composition-root HTTP tests as well as
 * `server/index.ts`; keeping the ordering in one place prevents a test from
 * accidentally mounting a feature at `/` and bypassing the production path.
 */
export function mountProtectedApiRoute(
  app: Pick<Application, 'use'>,
  mountPath: string,
  authenticate: RequestHandler,
  router: RequestHandler,
  ...capabilityGuards: readonly RequestHandler[]
): void {
  app.use(mountPath, authenticate, ...capabilityGuards, router);
}

/**
 * Mounts a capability-only boundary before an installation-wide API-key
 * middleware. The production composition root uses this for legacy routes
 * whose own credential check must remain intact, while a denied deployment
 * capability needs to win the response-order race over the global key.
 */
export function mountPreApiKeyCapabilityRoute(
  app: Pick<Application, 'use'>,
  mountPath: string,
  capabilityGuard: RequestHandler,
): void {
  app.use(mountPath, capabilityGuard);
}
