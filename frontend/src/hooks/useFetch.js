import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../api/client';

/**
 * Load data from the API and track loading / error state.
 *
 * Every list and detail page needs the same four things — data, a spinner flag,
 * an error message, and a way to refetch after a mutation — so they live here
 * instead of being re-implemented a dozen times.
 *
 * The `cancelled` flag matters: if a user types in a filter box quickly, several
 * requests are in flight at once and they can resolve out of order. Ignoring the
 * result of a superseded effect stops an older response from overwriting a newer
 * one, and stops React warning about setting state on an unmounted component.
 *
 *   const { data, loading, error, reload } = useFetch(
 *     () => customersApi.list({ page }),
 *     [page]
 *   );
 */
export default function useFetch(fetcher, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Bumped by reload() to re-run the effect without changing any real dependency.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError('');

    Promise.resolve()
      .then(fetcher)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `fetcher` is intentionally excluded: callers pass an inline arrow, which
    // is a new function on every render and would loop forever. The explicit
    // `deps` array is the contract instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload, setError };
}

/**
 * Debounce a rapidly-changing value (a search box, typically) so the list
 * endpoint is hit once the user pauses rather than on every keystroke.
 */
export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
