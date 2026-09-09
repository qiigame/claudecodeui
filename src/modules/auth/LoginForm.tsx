import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, User } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';
import { api } from '@/shared/api';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

/**
 * Login form component.
 * Rendered by the auth module's ProtectedRoute when no user session exists.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const {
    authMode,
    dingTalkProviders,
    error: sessionError,
    login,
  } = useAuth();
  // The server may be in SSO mode while its provider list is temporarily
  // empty (for example, a malformed/rotating credentials file). Never fall
  // back to a local password form in that state.
  const usesDingTalkLogin = authMode === 'dingtalk'
    || authMode === 'unavailable'
    || dingTalkProviders.length > 0;

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(formState.username.trim(), formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.username, login, t],
  );

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={usesDingTalkLogin ? t('login.dingTalkDescription') : t('login.description')}
      footerText={usesDingTalkLogin
        ? t('login.dingTalkFooter')
        : 'Enter your credentials to access CloudCLI'}
    >
      {usesDingTalkLogin ? (
        <div className="space-y-4">
          {dingTalkProviders.length > 0 ? (
            <div className="space-y-3">
              {dingTalkProviders.map((provider) => (
                <a
                  key={provider.key}
                  href={api.auth.dingTalkStartUrl(
                    provider.key,
                    `${window.location.pathname}${window.location.search}${window.location.hash}`,
                  )}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1677ff] px-4 py-2.5 font-medium text-white shadow-lg shadow-blue-500/20 transition-all duration-200 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99]"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 items-center justify-center rounded-md bg-white/20 text-sm font-semibold"
                  >
                    钉
                  </span>
                  钉钉登录 · {provider.name}
                </a>
              ))}
            </div>
          ) : (
            <AuthErrorAlert errorMessage="钉钉登录暂不可用，请联系管理员检查组织配置。" />
          )}
          <AuthErrorAlert errorMessage={sessionError || ''} />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <AuthInputField
            id="username"
            label={t('login.username')}
            value={formState.username}
            onChange={(value) => updateField('username', value)}
            placeholder={t('login.placeholders.username')}
            isDisabled={isSubmitting}
            autoComplete="username"
            icon={User}
          />

          <AuthInputField
            id="password"
            label={t('login.password')}
            value={formState.password}
            onChange={(value) => updateField('password', value)}
            placeholder={t('login.placeholders.password')}
            isDisabled={isSubmitting}
            type="password"
            autoComplete="current-password"
            icon={Lock}
          />

          <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

          <button
            type="submit"
            disabled={isSubmitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('login.loading')}
              </>
            ) : (
              t('login.submit')
            )}
          </button>
        </form>
      )}
    </AuthScreenLayout>
  );
}
