// @ts-nocheck -- JWT request augmentation is narrowed by Auth route contracts.
import jwt from 'jsonwebtoken';

import {
  collaborationService,
} from '@/modules/collaboration/index.js';
import { userDb, appConfigDb } from '../database/index.js';

import { AUTH_DEPLOYMENT_MODE } from './auth-policy.js';
import {
  extractBearerToken,
  extractBearerTokenFromQuery,
} from '@/shared/bearer-token.js';
import { withSettingsPermissions } from './settings-access.middleware.js';

// Capture deployment-owned settings administrators once, alongside the auth
// mode snapshot. Requests must not observe a mutable process.env change after
// startup (or let a test/request mutate the allowlist mid-flight).
const SETTINGS_ADMIN_USER_IDS = process.env.CLOUDCLI_SETTINGS_ADMIN_USER_IDS;
const withCollaborationActor = (user) => {
  const actor = collaborationService.getActorByUserId(user.id ?? user.userId);
  const authenticatedUser = actor
    ? { ...user, username: actor.displayName, actor }
    : user;
  return withSettingsPermissions(authenticatedUser, {
    configuredUserIds: SETTINGS_ADMIN_USER_IDS,
    deploymentProfile: AUTH_DEPLOYMENT_MODE.profile,
    requiresDingTalk: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
  });
};

/**
 * A deployment that advertises DingTalk/readonly authentication must never
 * accept a legacy local-password account (or the first database row) as a
 * valid principal. OAuth creates a trusted actor; every subsequent HTTP and
 * websocket request must carry that actor, even for read-only GET routes.
 */
const rejectInvalidSsoPrincipal = (authenticatedUser) => {
  if (!AUTH_DEPLOYMENT_MODE.requiresDingTalk) {
    return null;
  }

  const actor = authenticatedUser?.actor;
  if (!actor || actor.provider !== 'dingtalk') {
    return {
      error: 'DingTalk login is required for this deployment.',
      code: 'DINGTALK_LOGIN_REQUIRED',
      statusCode: 401,
    };
  }

  // Person mapping is attribution metadata, not authentication. Route-level
  // deployment capabilities and settings permissions remain authoritative for
  // writes, while commit hooks separately require verified attribution.
  return null;
};

/** Applies the SSO principal check before route-specific capability checks. */
const rejectAuthenticatedPrincipal = (_req, authenticatedUser) =>
  rejectInvalidSsoPrincipal(authenticatedUser);

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode: use the single database user only when the request carries
  // no credential at all. Once a caller presents an Authorization or query
  // token (including a malformed one), it must go through normal JWT
  // validation instead of silently falling back to the first account.
  const authHeader = req.headers['authorization'];
  const hasQueryCredential = req.query?.token !== undefined;
  if (AUTH_DEPLOYMENT_MODE.platformBypass
    && authHeader === undefined
    && !hasQueryCredential) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = withCollaborationActor(user);
      const mutationError = rejectAuthenticatedPrincipal(req, req.user);
      if (mutationError) return res.status(mutationError.statusCode ?? 403).json(mutationError);
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  // `authHeader` is intentionally read before the platform bypass above so
  // malformed credentials cannot be treated as anonymous platform traffic.
  // Never split an arbitrary Authorization value and assume the second word
  // is a JWT.  Only the Bearer scheme with exactly one non-whitespace
  // credential is accepted; Basic/Digest/malformed multi-token headers are
  // rejected before jwt.verify is called.  A malformed header must not be
  // silently replaced by a query credential either.
  const hasAuthorizationHeader = authHeader !== undefined;
  const queryToken = !hasAuthorizationHeader
    ? extractBearerTokenFromQuery(req.query.token)
    : null;
  const token = hasAuthorizationHeader
    ? extractBearerToken(authHeader)
    : queryToken;

  if (!token) {
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = withCollaborationActor(user);
    const principalError = rejectAuthenticatedPrincipal(req, req.user);
    if (principalError) return res.status(principalError.statusCode ?? 403).json(principalError);
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }

    console.warn(
      'Token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Legacy platform mode may resolve the first database user only when the
  // caller did not present a token. If a token is present, validate it just as
  // an OSS/SSO request; this keeps the verifier's token precedence intact.
  if (!token && AUTH_DEPLOYMENT_MODE.platformBypass) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        const authenticatedUser = withCollaborationActor({
          id: user.id,
          userId: user.id,
          username: user.username,
        });
        return rejectInvalidSsoPrincipal(authenticatedUser) ? null : authenticatedUser;
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    const authenticatedUser = withCollaborationActor({
      id: user.id,
      userId: user.id,
      username: user.username,
    });
    return rejectInvalidSsoPrincipal(authenticatedUser) ? null : authenticatedUser;
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) {
      console.warn(
        'WebSocket token verification failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};
