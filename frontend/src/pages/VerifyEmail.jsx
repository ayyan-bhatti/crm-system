import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { authApi } from '../api/resources';
import { ButtonLink, Card, Spinner } from '../components/common';
import AuthLayout from './AuthLayout';

/**
 * Where the "confirm your email" link in a staff sign-up email lands.
 *
 * See the identical buyer-side page (`pages/shop/VerifyEmail.jsx`) for the
 * full reasoning — check-then-confirm so a mail client's link-prefetching
 * cannot burn the one-time token, no session required to land here, and
 * nothing in the app is gated on this. The only CRM-specific fact worth
 * repeating: a self-signup account cannot sign in until an administrator
 * approves it regardless, so confirming an email here changes nothing about
 * whether — or when — that applicant can actually get in.
 */

/**
 * The heading for each outcome. Kept beside the state rather than inline in
 * the markup so there is exactly one place to read what this screen can say.
 */
const TITLES = {
  working: 'Confirming your email',
  done: 'Email confirmed',
  invalid: 'We could not do that',
  error: 'We could not do that',
};

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [state, setState] = useState({ status: 'working', message: '' });

  useEffect(() => {
    let cancelled = false;

    if (!token) {
      setState({
        status: 'invalid',
        message: 'This link is missing its confirmation code. Try copying the whole link from your email.',
      });
      return undefined;
    }

    authApi
      .checkEmailVerification(token)
      .then((check) => {
        if (cancelled) return null;
        if (!check.ok) {
          setState({
            status: 'invalid',
            message:
              'That confirmation link is not valid — it may have expired, already been used, or ' +
              'been broken up by your email program. You can request a new one from your account.',
          });
          return null;
        }

        return authApi.verifyEmail(token).then((result) => {
          if (cancelled) return;
          setState({ status: result.success ? 'done' : 'invalid', message: result.message });
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: 'Something went wrong on our side. Please try again in a moment.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const failed = state.status === 'invalid' || state.status === 'error';

  return (
    <AuthLayout
      eyebrow="Email confirmation"
      title={TITLES[state.status]}
      subtitle={state.status === 'working' ? 'One moment.' : undefined}
      live
    >
      <Card className="p-6 shadow-lift sm:p-7">
        {state.status === 'working' && <Spinner full />}

        {state.status === 'done' && (
          <p className="text-sm leading-relaxed text-ink-2">
            Thanks — your address is confirmed. If your account is still waiting on approval, this
            does not change that; an administrator will review it separately.
          </p>
        )}

        {failed && (
          <div className="flex items-start gap-3 rounded-lg border border-critical/25 bg-critical-wash px-4 py-3 text-sm text-critical-ink">
            <svg
              viewBox="0 0 20 20"
              className="mt-0.5 h-4 w-4 shrink-0 fill-current"
              aria-hidden="true"
            >
              <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
            </svg>
            <p>{state.message}</p>
          </div>
        )}

        <ButtonLink to="/crm/login" variant="secondary" className="mt-6 w-full">
          Back to sign in
        </ButtonLink>
      </Card>
    </AuthLayout>
  );
}
