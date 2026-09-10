import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { shopOrdersApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorBanner,
  Pagination,
  Skeleton,
  Spinner,
  StatusBadge,
} from '../../components/common';
import DeliveryTimeline from '../../components/DeliveryTimeline';
import ProductImage from '../../components/shop/ProductImage';
import { formatDate, galleryFor, input, link, money, orderLabel } from '../../ui';
import UrgencyBadge from '../../components/UrgencyBadge';

/**
 * A buyer's own order history.
 *
 * CARDS RATHER THAN A TABLE, and the reason is what a buyer comes here to do.
 * A staff member scans an order list — comparing rows, sorting, looking for an
 * outlier — which is exactly what a table is for. A shopper is looking for ONE
 * order, and they recognise it by the thing they bought, not by a date in a
 * column. So each row carries the pictures, the delivery progress and the
 * total, and the thing that is actually scannable is the photograph.
 */
export default function BuyerOrders() {
  const { isSignedIn, loading: authLoading } = useBuyerAuth();
  const [page, setPage] = useState(1);

  const { data, loading, error } = useFetch(
    () => (isSignedIn ? shopOrdersApi.list({ page, limit: 10 }) : Promise.resolve(null)),
    [isSignedIn, page]
  );

  if (authLoading) return <Spinner full />;
  if (!isSignedIn) return <Navigate to="/login" replace state={{ from: '/account/orders' }} />;

  const orders = data?.data || [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:py-14">
      <p className="label-mono">Your account</p>
      <h1 className="font-display mt-2 text-[32px] leading-tight text-ink sm:text-[36px]">
        Your orders
      </h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-ink-2">
        Everything you have bought, with where each one has got to.
      </p>

      <div className="mt-8">
        <AskAboutOrders />
      </div>

      {loading && (
        <div className="mt-6 space-y-4" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <Card key={row} className="flex gap-4 p-5">
              <Skeleton className="h-20 w-20 shrink-0" />
              <div className="flex-1 space-y-3 py-1">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </Card>
          ))}
        </div>
      )}

      <ErrorBanner message={error} />

      {data && orders.length === 0 && (
        <Card className="mt-6">
          <EmptyState
            title="You haven't placed an order yet"
            hint="Orders you place will show up here, with a delivery timeline for each one."
            action={<ButtonLink to="/products">Start shopping</ButtonLink>}
          />
        </Card>
      )}

      {orders.length > 0 && (
        <>
          <ul className="mt-6 space-y-4">
            {orders.map((order) => (
              <li key={order._id}>
                <OrderCard order={order} />
              </li>
            ))}
          </ul>

          {data.pagination && (
            <Card className="mt-4">
              <Pagination
                page={data.pagination.page}
                pages={data.pagination.pages}
                total={data.pagination.total}
                onChange={setPage}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One order in the list.
 *
 * The order number is its own link rather than the whole card being one. A card
 * that is entirely a link cannot hold a second link, reads as one enormous
 * target to a screen reader, and — the practical part — makes the accessible
 * name of the link every word in the card.
 */
function OrderCard({ order }) {
  const items = order.items || [];
  const shown = items.slice(0, 3);
  const overflow = items.length - shown.length;

  return (
    <Card className="p-5 transition-shadow hover:shadow-lift">
      <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
        {/* The thumbnails. Recognition beats reading in a list somebody is
            scanning for one specific purchase. */}
        <div className="flex shrink-0 gap-2">
          {shown.map((item, index) => (
            <div
              key={index}
              className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-hairline bg-neutral-wash sm:h-20 sm:w-20"
            >
              {item.product ? (
                <ProductImage
                  product={item.product}
                  src={galleryFor(item.product)[0]}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : null}
            </div>
          ))}
          {overflow > 0 && (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-rule text-xs font-semibold text-muted sm:h-20 sm:w-20">
              +{overflow}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-base font-semibold">
              <Link to={`/account/orders/${order._id}`} className={link}>
                {orderLabel(order)}
              </Link>
            </h2>
            <span className="text-base font-semibold text-ink tabular">{money(order.total)}</span>
          </div>

          <p className="mt-1 text-xs text-muted">
            Placed {formatDate(order.createdAt)} · {items.length}{' '}
            {items.length === 1 ? 'item' : 'items'}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/*
              The DELIVERY status, not the commercial one — this is the
              buyer's own list, and "pending" describes internal bookkeeping
              rather than anything they can act on.
            */}
            <StatusBadge value={order.fulfilment || 'processing'} />
            <UrgencyBadge order={order} />
          </div>

          {/*
            The compact rail. It is the only thing in the row that shows how
            far along an order is without being read, which is what a list of
            six near-identical badges cannot do.
          */}
          <div className="mt-4 max-w-xs">
            <DeliveryTimeline order={order} compact />
          </div>

          {order.estimatedDeliveryAt && order.fulfilment !== 'delivered' && (
            <p className="mt-2.5 text-xs text-muted">
              Estimated delivery {formatDate(order.estimatedDeliveryAt)}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * The storefront's order-status assistant. A single free-text question over
 * everything the buyer has ordered — placed on the list page rather than one
 * order's detail page because a question ("where is my last order?") is not
 * naturally scoped to whichever order happened to be open.
 */
function AskAboutOrders() {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState('');
  const [references, setReferences] = useState([]);
  const [askError, setAskError] = useState('');

  async function handleAsk(event) {
    event.preventDefault();
    if (!question.trim()) return;

    setAsking(true);
    setAskError('');
    setAnswer('');
    setReferences([]);

    try {
      const result = await shopOrdersApi.ask(question.trim());
      setAnswer(result.answer);
      setReferences(result.references || []);
    } catch (err) {
      setAskError(errorMessage(err, 'Could not get an answer'));
    } finally {
      setAsking(false);
    }
  }

  return (
    <Card className="bg-sunken/50 p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-ink">Ask about your orders</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Try &quot;when will my last order arrive?&quot; or &quot;how many orders have I placed?&quot;
      </p>

      <form onSubmit={handleAsk} noValidate className="mt-4 flex flex-col gap-2.5 sm:flex-row">
        <input
          type="text"
          className={`${input} flex-1`}
          placeholder="Ask a question about your orders"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Ask about your orders"
        />
        <Button
          type="submit"
          variant="secondary"
          className="sm:shrink-0"
          loading={asking}
          loadingLabel="Asking…"
          disabled={!question.trim()}
        >
          Ask
        </Button>
      </form>

      <ErrorBanner message={askError} />

      {answer && (
        <p className="mt-4 border-l-2 border-brand pl-4 text-sm leading-relaxed text-ink-2">
          {answer}
        </p>
      )}

      {/*
        The order(s) the answer is actually about, as real rows rather than
        an id flattened into the sentence above — code decided which orders
        these are (see orderAssistantService's allow-list), the model only
        chose which of them the question was about.
      */}
      {references.length > 0 && (
        <ul className="mt-4 space-y-2">
          {references.map((ref) => (
            <li key={ref.orderId}>
              <Link
                to={`/account/orders/${ref.orderId}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-surface p-3.5 transition-colors hover:border-rule hover:bg-plane"
              >
                <span>
                  <span className="text-sm font-semibold text-ink">{orderLabel(ref)}</span>
                  <span className="ml-2 text-xs text-muted">{formatDate(ref.createdAt)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge value={ref.fulfilment || 'processing'} />
                  <UrgencyBadge order={ref} />
                  <span className="text-sm font-semibold text-ink tabular">{money(ref.total)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
