import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/resources';
import { Card, Spinner } from '../components/common';
import { btnSecondary } from '../ui';

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

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card className="p-8 text-center">
        {state.status === 'working' && (
          <>
            <Spinner />
            <p className="mt-3 text-sm text-muted">Confirming your email…</p>
          </>
        )}

        {state.status === 'done' && (
          <>
            <h1 className="text-xl font-semibold text-ink">Email confirmed</h1>
            <p className="mt-3 text-sm text-ink-2">
              Thanks — your address is confirmed. If your account is still waiting on approval,
              this does not change that; an administrator will review it separately.
            </p>
          </>
        )}

        {(state.status === 'invalid' || state.status === 'error') && (
          <>
            <h1 className="text-xl font-semibold text-ink">We could not do that</h1>
            <p className="mt-3 text-sm text-ink-2">{state.message}</p>
          </>
        )}

        <Link to="/crm/login" className={`${btnSecondary} mt-6 inline-flex`}>
          Back to sign in
        </Link>
      </Card>
    </div>
  );
}
