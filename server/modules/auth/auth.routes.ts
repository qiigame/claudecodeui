import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';
import {
  DINGTALK_SESSION_COOKIE,
  DINGTALK_STATE_COOKIE,
  type createDingTalkOAuthService,
} from './dingtalk-oauth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
  dingTalkOAuth?: ReturnType<typeof createDingTalkOAuthService>,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.get('/dingtalk/start', (req, res, next) => {
    try {
      if (!dingTalkOAuth) {
        throw new Error('DingTalk OAuth service is unavailable.');
      }
      const login = dingTalkOAuth.beginLogin(req.query.provider, req.query.returnTo);
      res.cookie(DINGTALK_STATE_COOKIE, login.state, {
        httpOnly: true,
        secure: login.secureCookies,
        sameSite: 'lax',
        path: '/api/auth/dingtalk/callback',
        maxAge: 10 * 60 * 1000,
      });
      res.redirect(302, login.authorizeUrl);
    } catch (error) {
      next(error);
    }
  });

  router.get('/dingtalk/callback', async (req, res, next) => {
    try {
      if (!dingTalkOAuth) {
        throw new Error('DingTalk OAuth service is unavailable.');
      }
      const cookieHeader = String(req.headers.cookie ?? '');
      const stateCookie = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${DINGTALK_STATE_COOKIE}=`))
        ?.slice(DINGTALK_STATE_COOKIE.length + 1);
      const login = await dingTalkOAuth.completeLogin({
        code: req.query.authCode ?? req.query.code,
        state: req.query.state,
        stateCookie,
      });
      res.clearCookie(DINGTALK_STATE_COOKIE, { path: '/api/auth/dingtalk/callback' });
      res.cookie(DINGTALK_SESSION_COOKIE, login.session, {
        httpOnly: true,
        secure: login.secureCookies,
        sameSite: 'lax',
        path: '/api/auth/dingtalk/session',
        maxAge: 90 * 1000,
      });
      res.redirect(303, login.returnTo);
    } catch (error) {
      res.clearCookie(DINGTALK_STATE_COOKIE, { path: '/api/auth/dingtalk/callback' });
      next(error);
    }
  });

  router.get('/dingtalk/session', (req, res, next) => {
    try {
      if (!dingTalkOAuth) {
        throw new Error('DingTalk OAuth service is unavailable.');
      }
      const cookieHeader = String(req.headers.cookie ?? '');
      const sessionCookie = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${DINGTALK_SESSION_COOKIE}=`))
        ?.slice(DINGTALK_SESSION_COOKIE.length + 1);
      const session = dingTalkOAuth.consumeSession(sessionCookie);
      res.clearCookie(DINGTALK_SESSION_COOKIE, { path: '/api/auth/dingtalk/session' });
      res.json(session);
    } catch (error) {
      res.clearCookie(DINGTALK_SESSION_COOKIE, { path: '/api/auth/dingtalk/session' });
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
