import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { unsubscribeApi } from '../../api/resources';
import { Card, Spinner } from '../../components/common';
import { btnSecondary } from '../../ui';

/**
 * Where the unsubscribe link in a marketing email lands.
 *
 * ============================================================================
 * IT UNSUBSCRIBES ON ARRIVAL, WITHOUT A CONFIRMATION BUTTON
 * ============================================================================
 *
 * A confirmation step is the conventional design and it is the wrong one here.
 * Someone who clicked "unsubscribe" has already made their decision; asking
 * them to make it twice is friction placed deliberately in front of a person
 * trying to stop unwanted mail, which is the definition of the dark pattern
 * this is meant to avoid. The brief is explicit that clicking the link flips
 * the consent off, and it does.
 *
 * The prefetch problem that a confirmation step usually solves is handled a
 * different way: the API's GET is a read-only *check* of what the token would
 * do, and the change is a POST issued from here. Mail clients and security
 * scanners that fetch every link before a human sees it therefore hit the
 * harmless half. A scanner that also runs the page's JavaScript would trigger
 * the unsubscribe — which would be a false unsubscribe rather than a false
 * subscription, and is the right way round to be wrong.
 *
 * It is idempotent, so a second click, a refresh or a back-button visit says
 * "you were already unsubscribed" rather than failing.
 *
 * ============================================================================
 * WHY THIS PAGE IS NOT BEHIND A LOGIN
 * ============================================================================
 *
 * A guest contact — somebody who checked out before accounts were mandatory —
 * has no account to sign in to. Requiring one would make it impossible for
 * exactly the people least likely to want the mail. The signed token in the
 * link is the authorisation; see backend/src/services/unsubscribeService.js.
 */
export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [state, setState] = useState({ status: 'working', message: '', channelLabel: '' });

  useEffect(() => {
    let cancelled = false;

    if (!token) {
      setState({
        status: 'invalid',
        message:
          'This link is missing its unsubscribe code. Try copying the whole link from the ' +
          'email into your browser, or reply to the message and we will take you off the list.',
      });
      return undefined;
    }

    /*
     * Check first, then act. The check tells the page which channel this is
     * for, so the confirmation can say "marketing emails" rather than a vague
     * "you have been unsubscribed" that leaves somebody wondering whether the
     * text messages will stop too.
     */
    unsubscribeApi
      .check(token)
      .then((check) => {
        if (cancelled) return null;
        if (!check.valid) {
          setState({
            status: 'invalid',
            message:
              'That unsubscribe link is not valid. It may have been broken up by your email ' +
              'program — try copying the whole link into your browser, or reply to the message ' +
              'and we will take you off the list.',
          });
          return null;
        }

        return unsubscribeApi.confirm(token).then((result) => {
          if (cancelled) return;

          setState({
            status: result.success ? 'done' : 'invalid',
            message: result.message,
            channelLabel: check.channelLabel,
          });
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          status: 'error',
          message:
            'Something went wrong on our side. Please try again in a moment — and if it keeps ' +
            'happening, reply to the message and we will take you off the list by hand.',
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
            <p className="mt-3 text-sm text-muted">Updating your preferences…</p>
          </>
        )}

        {state.status === 'done' && (
          <>
            <h1 className="text-xl font-semibold text-ink">
              {state.channelLabel ? `Unsubscribed from ${state.channelLabel}` : 'Unsubscribed'}
            </h1>
            <p className="mt-3 text-sm text-ink-2">{state.message}</p>
            <p className="mt-3 text-xs text-muted">
              You will still receive messages about orders you place — confirmations, delivery
              updates and anything you ask us about. Those are not marketing and are not affected.
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
