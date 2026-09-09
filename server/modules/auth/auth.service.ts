import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
  /** Resolves the server-owned settings capability for a newly authenticated user. */
  getSettingsPermission?: (user: AuthUser) => boolean;
  getDingTalkStatus?: () => {
    enabled: boolean;
    providers: Array<{ key: string; name: string }>;
  };
  /**
   * Deployment-owned switch for local-password authentication. This must be
   * supplied by the composition root; it is never derived from request data.
   */
  isPasswordLoginEnabled?: () => boolean;
  /** Public auth-mode metadata consumed by the login screen. */
  getAuthMode?: () => {
    mode: 'platform' | 'dingtalk' | 'password' | 'unavailable';
    requiresLogin: boolean;
    passwordLoginEnabled: boolean;
  };
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  const passwordLoginEnabled = (): boolean => {
    // Direct unit/test consumers that do not inject a deployment switch retain
    // the historical local-password behavior. Production always injects one.
    return dependencies.isPasswordLoginEnabled?.() ?? true;
  };

  const passwordAuthDisabledError = (operation: 'login' | 'register'): AppError =>
    new AppError(
      operation === 'register'
        ? 'Password registration is disabled for this deployment. Use DingTalk login.'
        : 'Password login is disabled for this deployment. Use DingTalk login.',
      {
        code: operation === 'register' ? 'AUTH_REGISTRATION_DISABLED' : 'AUTH_PASSWORD_LOGIN_DISABLED',
        statusCode: 403,
      },
    );

  const canManageSettings = (user: AuthUser): boolean =>
    dependencies.getSettingsPermission?.(user) ?? false;

  return {
    getStatus() {
      const dingTalk = dependencies.getDingTalkStatus?.() ?? { enabled: false, providers: [] };
      const mode = dependencies.getAuthMode?.();
      const status = {
        // An SSO/managed deployment must never expose the first-run local
        // password setup screen, even while its credentials are temporarily
        // unavailable. Showing setup there would advertise a registration
        // path that the same deployment correctly rejects.
        needsSetup: !dependencies.users.hasUsers()
          && !dingTalk.enabled
          && mode?.mode !== 'dingtalk'
          && mode?.mode !== 'platform'
          && mode?.mode !== 'unavailable',
        isAuthenticated: false,
        dingTalk,
      };
      return mode
        ? { ...status, authMode: mode }
        : status;
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      if (!passwordLoginEnabled() || dependencies.getDingTalkStatus?.().enabled) {
        throw passwordAuthDisabledError('register');
      }

      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: {
            id: user.id,
            username: user.username,
            permissions: { manageSettings: canManageSettings(user) },
          },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown) {
      if (!passwordLoginEnabled() || dependencies.getDingTalkStatus?.().enabled) {
        throw passwordAuthDisabledError('login');
      }

      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user && !user.password_hash.startsWith('!dingtalk-oauth:')
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          permissions: { manageSettings: canManageSettings(user) },
        },
        token: dependencies.generateToken(user),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
