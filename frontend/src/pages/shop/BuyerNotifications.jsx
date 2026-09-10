import { Navigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { shopMessagesApi } from '../../api/shopResources';
import useFetch from '../../hooks/useFetch';
import {
  ButtonLink,
  Card,
  EmptyState,
  ErrorBanner,
  Skeleton,
  Spinner,
} from '../../components/common';
import { formatDateTime, OUTBOUND_KIND_LABELS } from '../../ui';

/**
 * A signed-in buyer's own notifications: the marketing campaigns actually
 * delivered to them, newest first. See `shopMessageController.listMyMessages`
 * for why this shows only delivered campaign sends — not the internal
 * automation log, and not a send this buyer was correctly skipped for lack
 * of consent.
 *
 * READ AS A LETTER, NOT AS A FEED. Each message gets a subject line in the
 * display face, a date, and its body at a comfortable measure — because that
 * is what it actually is, an email that happens to be readable here too.
 * Nothing is styled as unread, badged, or counted: this is an archive of things
 * already sent, and dressing it up as an inbox would promise an interaction
 * that does not exist.
 */
export default function BuyerNotifications() {
  const { isSignedIn, loading: authLoading } = useBuyerAuth();

  const { data, loading, error } = useFetch(
    () => (isSignedIn ? shopMessagesApi.list() : Promise.resolve(null)),
    [isSignedIn]
  );

  if (authLoading) return <Spinner full />;
  if (!isSignedIn) {
    return <Navigate to="/login" replace state={{ from: '/account/notifications' }} />;
  }

  const messages = data?.data || [];

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 lg:py-14">
      <p className="label-mono">Your account</p>
      <h1 className="font-display mt-2 text-[32px] leading-tight text-ink sm:text-[36px]">
        Notifications
      </h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-ink-2">
        Everything we have sent you, kept here so nothing is only ever in an inbox.
      </p>

      {loading && (
        <div className="mt-8 space-y-4" aria-hidden="true">
          {[0, 1].map((row) => (
            <Card key={row} className="space-y-3 p-6">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </Card>
          ))}
        </div>
      )}

      <ErrorBanner message={error} />

      {data && messages.length === 0 && (
        <Card className="mt-8">
          <EmptyState
            title="Nothing here yet"
            hint="Promotions and updates we send you will show up here. You choose which of those you get — nothing arrives unless you have opted in."
            action={<ButtonLink to="/products" variant="secondary">Browse the shop</ButtonLink>}
          />
        </Card>
      )}

      {messages.length > 0 && (
        <ol className="mt-8 space-y-4">
          {messages.map((message) => (
            <li key={message.id}>
              <Card className="p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="font-display min-w-0 text-[22px] leading-tight text-ink">
                    {message.subject || message.campaignName}
                  </h2>
                  <time className="shrink-0 text-xs text-muted">
                    {formatDateTime(message.sentAt)}
                  </time>
                </div>

                {/*
                  What kind of message it was, when the server says. A subject
                  line alone does not tell somebody whether they are looking at
                  a promotion or a reminder about something they bought, and
                  those are read very differently.
                */}
                {message.kind && OUTBOUND_KIND_LABELS[message.kind] && (
                  <p className="label-mono mt-2">{OUTBOUND_KIND_LABELS[message.kind]}</p>
                )}

                {message.body && (
                  <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
                    {message.body}
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
