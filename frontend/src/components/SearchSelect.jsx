import { useEffect, useId, useRef, useState } from 'react';
import { useDebounced } from '../hooks/useFetch';
import { input } from '../ui';
import { Spinner } from './common';

/**
 * A search-as-you-type picker backed by a server endpoint.
 *
 * WHAT IT REPLACES, AND WHY THAT MATTERED
 *
 * The order form used a plain `<select>` filled by fetching `limit=100`. That
 * has two failure modes, and the second is the dangerous one:
 *
 *   1. It downloads a hundred records to render a dropdown, on every visit.
 *   2. With more than a hundred customers, the ones past the limit SIMPLY DO
 *      NOT EXIST as far as the form is concerned. No error, no "showing 100 of
 *      4,000" — a user just cannot find their customer and has no idea why.
 *
 * Searching server-side fixes both: the query runs where the data is, and the
 * result set is bounded by relevance rather than by an arbitrary cut-off.
 *
 * THREE THINGS THIS HAS TO GET RIGHT
 *
 * `selected` is held by the PARENT, not looked up from the options list. The
 * currently chosen customer is very often not in the twenty results for
 * whatever the user last typed — so a component that derived its label from the
 * options would blank out the selection the moment the search changed. That is
 * the bug most hand-rolled async selects have.
 *
 * Requests are debounced AND stale replies are discarded. Debouncing alone is
 * not enough: two requests can still be in flight, and the slower one can land
 * last and overwrite newer results with older ones.
 *
 * It is a real combobox for keyboard and screen-reader users — arrow keys,
 * Enter, Escape, and the aria roles that make the listbox announceable. A
 * div-based picker that only works with a mouse is a regression from the
 * `<select>` it replaced, however much better it looks.
 */
export default function SearchSelect({
  value,
  selected,
  onChange,
  fetchOptions,
  getOptionLabel,
  getOptionMeta,
  placeholder = 'Search…',
  emptyMessage = 'No matches',
  required = false,
  id,
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const containerRef = useRef(null);
  const generatedId = useId();
  const listboxId = `${id || generatedId}-listbox`;

  // 250ms: long enough that ordinary typing produces one request rather than
  // eight, short enough that the list feels like it is keeping up.
  const debouncedQuery = useDebounced(query, 250);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    setLoading(true);

    fetchOptions(debouncedQuery)
      .then((results) => {
        // The guard that matters: without it a slow earlier request can resolve
        // after a fast later one and replace correct results with stale ones.
        if (cancelled) return;
        setOptions(results);
        setHighlighted(0);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `fetchOptions` is an inline arrow from the parent and would be a new
    // function every render, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, open]);

  /** Close when the user clicks away, which is what a dropdown is expected to do. */
  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function choose(option) {
    onChange(option);
    setOpen(false);
    setQuery('');
  }

  function handleKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Prevent the caret jumping to the start/end of the input while the
      // arrow keys are being used to move through the list.
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((current) => {
        if (!options.length) return 0;
        return (current + step + options.length) % options.length;
      });
    } else if (event.key === 'Enter') {
      if (open && options[highlighted]) {
        // Otherwise Enter would submit the surrounding form while the user was
        // only trying to pick an option.
        event.preventDefault();
        choose(options[highlighted]);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  // When closed, the field shows the current selection; when open, it shows
  // what is being typed. Two states, one input — which is what makes it feel
  // like a select rather than a search box that happens to set a value.
  const displayValue = open ? query : selected ? getOptionLabel(selected) : '';

  return (
    <div ref={containerRef} className="relative">
      <input
        id={id}
        type="text"
        className={input}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[highlighted] ? `${listboxId}-${highlighted}` : undefined}
        autoComplete="off"
        placeholder={selected ? getOptionLabel(selected) : placeholder}
        value={displayValue}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />

      {/*
        A hidden required input carries the browser's native validation.
        The visible combobox holds a label, not the id, so marking IT required
        would demand the wrong thing — and dropping validation entirely would
        lose the "please fill in this field" behaviour a plain select had.
      */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute h-0 w-0 opacity-0"
          value={value || ''}
          onChange={() => {}}
          required
        />
      )}

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-hairline bg-surface py-1 shadow-lift"
        >
          {loading && (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
              <Spinner /> Searching…
            </li>
          )}

          {!loading && !options.length && (
            <li className="px-3 py-2 text-sm text-muted">{emptyMessage}</li>
          )}

          {!loading &&
            options.map((option, index) => (
              <li
                key={option._id}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={option._id === value}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  index === highlighted ? 'bg-brand-wash text-brand-ink' : 'text-ink'
                }`}
                // onMouseDown rather than onClick: click fires after the input's
                // blur, by which time the click-outside handler has already
                // closed the list and the selection never happens.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setHighlighted(index)}
              >
                <span className="font-medium">{getOptionLabel(option)}</span>
                {getOptionMeta && (
                  <span className="ml-2 text-xs text-muted">{getOptionMeta(option)}</span>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
