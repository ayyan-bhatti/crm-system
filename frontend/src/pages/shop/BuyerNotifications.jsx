import { Navigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { shopMessagesApi } from '../../api/shopResources';
import useFetch from '../../hooks/useFetch';
import { Card, EmptyState, ErrorBanner, Spinner } from '../../components/common';
import { formatDateTime } from '../../ui';

/**
 * A signed-in buyer's own notifications: the marketing campaigns actually
 * delivered to them, newest first. See `shopMessageController.listMyMessages`
 * for why this shows only delivered campaign sends — not the internal
 * automation log, and not a send this buyer was correctly skipped for lack
 * of consent.
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
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="font-display mb-6 text-3xl font-semibold text-ink">Notifications</h1>

      {loading && <Spinner full />}
      <ErrorBanner message={error} />

      {data && messages.length === 0 && (
        <Card>
          <EmptyState
            title="Nothing here yet"
            hint="Promotions and updates we send you will show up here."
          />
        </Card>
      )}

      {messages.length > 0 && (
        <div className="space-y-3">
          {messages.map((message) => (
            <Card key={message.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-ink">
                  {message.subject || message.campaignName}
                </p>
                <span className="shrink-0 text-xs text-muted">
                  {formatDateTime(message.sentAt)}
                </span>
              </div>
              {message.body && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2">{message.body}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
