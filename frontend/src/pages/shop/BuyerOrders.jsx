import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { shopOrdersApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import {
  Card,
  EmptyState,
  ErrorBanner,
  Pagination,
  Spinner,
  StatusBadge,
} from '../../components/common';
import { btnSecondary, formatDate, input, link, money, orderLabel, td, th } from '../../ui';

export default function BuyerOrders() {
  const { isSignedIn, loading: authLoading } = useBuyerAuth();
  const [page, setPage] = useState(1);

  const { data, loading, error } = useFetch(
    () => (isSignedIn ? shopOrdersApi.list({ page, limit: 10 }) : Promise.resolve(null)),
    [isSignedIn, page]
  );

  if (authLoading) return <Spinner full />;
  if (!isSignedIn) return <Navigate to="/shop/login" replace state={{ from: '/shop/account/orders' }} />;

  const orders = data?.data || [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="font-display mb-6 text-3xl font-semibold text-ink">Your orders</h1>

      <AskAboutOrders />

      {loading && <Spinner full />}
      <ErrorBanner message={error} />

      {data && orders.length === 0 && (
        <Card>
          <EmptyState
            title="You haven't placed an order yet"
            hint="Orders you place will show up here."
            action={
              <Link to="/shop/products" className={link}>
                Start shopping
              </Link>
            }
          />
        </Card>
      )}

      {orders.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-hairline bg-plane">
                <tr>
                  <th className={th}>Order</th>
                  <th className={th}>Date</th>
                  <th className={th}>Status</th>
                  <th className={`${th} text-right`}>Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {orders.map((order) => (
                  <tr key={order._id} className="hover:bg-plane">
                    <td className={td}>
                      <Link to={`/shop/account/orders/${order._id}`} className={link}>
                        {orderLabel(order)}
                      </Link>
                    </td>
                    <td className={td}>{formatDate(order.createdAt)}</td>
                    <td className={td}>
                      <StatusBadge value={order.status} />
                    </td>
                    <td className={`${td} text-right font-medium text-ink tabular`}>
                      {money(order.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.pagination && (
            <Pagination
              page={data.pagination.page}
              pages={data.pagination.pages}
              total={data.pagination.total}
              onChange={setPage}
            />
          )}
        </Card>
      )}
    </div>
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
  const [askError, setAskError] = useState('');

  async function handleAsk(event) {
    event.preventDefault();
    if (!question.trim()) return;

    setAsking(true);
    setAskError('');
    setAnswer('');

    try {
      const result = await shopOrdersApi.ask(question.trim());
      setAnswer(result.answer);
    } catch (err) {
      setAskError(errorMessage(err, 'Could not get an answer'));
    } finally {
      setAsking(false);
    }
  }

  return (
    <Card className="mb-6 p-5">
      <h2 className="text-sm font-semibold text-ink">Ask about your orders</h2>
      <p className="mt-1 text-xs text-muted">
        Try &quot;when will my last order arrive?&quot; or &quot;how many orders have I placed?&quot;
      </p>

      <form onSubmit={handleAsk} className="mt-3 flex gap-2">
        <input
          type="text"
          className={`${input} flex-1`}
          placeholder="Ask a question about your orders"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Ask about your orders"
        />
        <button type="submit" className={btnSecondary} disabled={asking || !question.trim()}>
          {asking ? <Spinner /> : 'Ask'}
        </button>
      </form>

      <ErrorBanner message={askError} />

      {answer && <p className="mt-3 text-sm text-ink-2">{answer}</p>}
    </Card>
  );
}
