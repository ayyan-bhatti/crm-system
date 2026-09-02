import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { shopVerifyEmailApi } from '../../api/shopResources';
import { Card, Spinner } from '../../components/common';
import { btnSecondary } from '../../ui';

/**
 * Where the "confirm your email" link in a buyer's registration email lands.
 *
 * Same check-then-confirm shape as `Unsubscribe.jsx`, and the same reason:
 * GET only checks whether the token is currently valid, and never redeems it
 * — a mail client or security scanner prefetching the link must not be able
 * to burn a real user's one-time token before they ever see the page. The
 * confirming POST is issued from here, once, after that check passes.
 *
 * No login required to land here — a buyer clicking this from a different
 * device, or a second browser with no session, still has to be able to
 * finish. The token itself is the authorisation; see
 * backend/src/services/emailVerificationService.js.
 *
 * Nothing in the app is BLOCKED by this — see the `emailVerified` field's
 * own comment on the Buyer model. Landing here just confirms an address that
 * already works.
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

    shopVerifyEmailApi
      .check(token)
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

        return shopVerifyEmailApi.confirm(token).then((result) => {
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
              Thanks — your address is confirmed. You did not need this to shop or check out; it
              is just good to have on file.
            </p>
          </>
        )}

        {(state.status === 'invalid' || state.status === 'error') && (
          <>
            <h1 className="text-xl font-semibold text-ink">We could not do that</h1>
            <p className="mt-3 text-sm text-ink-2">{state.message}</p>
          </>
        )}

        <Link to="/" className={`${btnSecondary} mt-6 inline-flex`}>
          Back to the shop
        </Link>
      </Card>
    </div>
  );
}
