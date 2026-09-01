import { useMemo, useState } from 'react';
import { contactsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import { useToast } from '../../components/Toast';
import {
  Card,
  ErrorBanner,
  ListEmptyState,
  PageHeader,
  Spinner,
  TableSkeleton,
} from '../../components/common';
import ContactPanel from './ContactPanel';
import {
  CONTACT_CHANNELS,
  CONTACT_SOURCE_LABELS,
  SEGMENT_LABELS,
  SEGMENT_STYLES,
  btnSecondary,
  consentCount,
  input,
  td,
  th,
} from '../../ui';

/**
 * Marketing contacts — every person this business can reach, in one list.
 *
 * WHY THIS IS A SEPARATE SCREEN FROM THE CUSTOMER BOOK
 *
 * They are the same people and different questions, which is exactly the case
 * for two screens rather than one with a toggle. The customer book answers
 * "who is this account and what have they bought" — one record at a time, with
 * notes and history. This answers "who can we contact, on what, and about
 * what" — the whole list at once, and it MERGES the storefront buyers the
 * customer book does not show at all.
 *
 * A sales rep sees this screen and not the customer book, which looks
 * inconsistent and is not: the server scopes them to the customers on orders
 * assigned to them, which is contact detail they already receive with every
 * order. See `contactService.visibleCustomerIds`.
 *
 * WHY THE WHOLE LIST RATHER THAN PAGES
 *
 * The list is a merge of two collections plus a segment computed per row, so
 * it cannot be paginated at the database without producing pages whose
 * contents shift. It is bounded by the scope query instead. The filters are
 * the navigation, which is also what makes them worth putting across the top
 * rather than behind a menu.
 */

/** The filter bar's state, as one object so a reset is one assignment. */
const NO_FILTERS = {
  source: '',
  segment: '',
  channel: '',
  optedIn: '',
  tag: '',
  search: '',
};

export default function ContactList() {
  const { can } = usePermissions();
  const toast = useToast();

  const [filters, setFilters] = useState(NO_FILTERS);
  const [selected, setSelected] = useState(null);
  const [exporting, setExporting] = useState(false);

  /*
   * The query sent to the server, with empty values stripped.
   *
   * The opt-in filter is TWO parameters that only mean something together —
   * "opted in" is not a question until you say to what — and the server
   * rejects one without the other. Dropping both unless both are set keeps
   * that contract on this side rather than discovering it as a 400.
   */
  const query = useMemo(() => {
    const params = {};
    if (filters.source) params.source = filters.source;
    if (filters.segment) params.segment = filters.segment;
    if (filters.tag) params.tag = filters.tag;
    if (filters.search) params.search = filters.search;
    if (filters.channel && filters.optedIn) {
      params.channel = filters.channel;
      params.optedIn = filters.optedIn;
    }
    return params;
  }, [filters]);

  /*
   * Keyed on the SERIALISED query rather than the object.
   *
   * `useFetch` compares its dependency array by identity, and `query` is a
   * fresh object on every render — passing it directly refetches forever. The
   * string is stable whenever the actual filters are, which is the thing that
   * should drive a reload.
   */
  const queryKey = JSON.stringify(query);
  const { data, loading, error, reload } = useFetch(() => contactsApi.list(query), [queryKey]);

  const contacts = data?.data || [];
  const options = data?.options;

  const filtered = Object.values(filters).some(Boolean);

  function setFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  /**
   * Download the current view.
   *
   * The blob is turned into an object URL, clicked, and revoked. Doing it this
   * way rather than pointing a link at the endpoint is what lets the request
   * carry the session cookie and the CSRF header the API client already
   * attaches — a bare `<a href>` would send neither and get a 401.
   *
   * The URL is revoked in a `finally` because leaking one holds the whole file
   * in memory for the life of the tab, and this file is the entire contact
   * book.
   */
  async function handleExport() {
    setExporting(true);
    let url = '';

    try {
      const blob = await contactsApi.exportUrl(query);

      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `contacts-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();

      toast.success(`Exported ${contacts.length} contacts`);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not export contacts'));
    } finally {
      if (url) URL.revokeObjectURL(url);
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Marketing contacts"
        subtitle="Everyone this business can reach — CRM customers, storefront buyers and guests, merged by email."
        action={
          can.exportContacts && (
            <button
              type="button"
              className={btnSecondary}
              onClick={handleExport}
              disabled={exporting || !contacts.length}
            >
              {exporting ? <Spinner /> : 'Export to Excel'}
            </button>
          )
        }
      />

      <ErrorBanner message={error} />

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Search</span>
            <input
              className={input}
              placeholder="Name or email"
              value={filters.search}
              onChange={(e) => setFilter('search', e.target.value)}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Source</span>
            <select
              className={input}
              value={filters.source}
              onChange={(e) => setFilter('source', e.target.value)}
            >
              <option value="">Any source</option>
              {(options?.sources || []).map((source) => (
                <option key={source} value={source}>
                  {CONTACT_SOURCE_LABELS[source] || source}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Segment</span>
            <select
              className={input}
              value={filters.segment}
              onChange={(e) => setFilter('segment', e.target.value)}
            >
              <option value="">Any segment</option>
              {(options?.segments || []).map((segment) => (
                <option key={segment} value={segment}>
                  {SEGMENT_LABELS[segment] || segment}
                </option>
              ))}
            </select>
          </label>

          {/*
            The two halves of the opt-in filter, side by side and visibly
            paired. Split across the form they would look like independent
            controls, and setting one alone does nothing — which reads as a
            broken filter rather than an incomplete one.
          */}
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Opt-in channel</span>
            <select
              className={input}
              value={filters.channel}
              onChange={(e) => setFilter('channel', e.target.value)}
            >
              <option value="">Any channel</option>
              {CONTACT_CHANNELS.map((channel) => (
                <option key={channel.value} value={channel.value}>
                  {channel.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Opted in?</span>
            <select
              className={input}
              value={filters.optedIn}
              onChange={(e) => setFilter('optedIn', e.target.value)}
              disabled={!filters.channel}
            >
              <option value="">Either</option>
              <option value="yes">Opted in</option>
              <option value="no">Not opted in</option>
            </select>
          </label>
        </div>

        {filtered && (
          <button
            type="button"
            className="mt-3 text-sm text-ink-2 underline hover:text-ink"
            onClick={() => setFilters(NO_FILTERS)}
          >
            Clear filters
          </button>
        )}
      </Card>

      {loading && <TableSkeleton rows={6} columns={5} />}

      {!loading && !contacts.length && (
        <ListEmptyState
          filtered={filtered}
          entity="contacts"
          onClear={() => setFilters(NO_FILTERS)}
        />
      )}

      {!loading && contacts.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-hairline">
              <thead className="bg-plane">
                <tr>
                  <th className={th}>Contact</th>
                  <th className={th}>Source</th>
                  <th className={th}>Opt-ins</th>
                  <th className={th}>Segments</th>
                  <th className={th}>Tags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {contacts.map((contact) => {
                  const { opted, total } = consentCount(contact);

                  return (
                    <tr
                      key={contact.email}
                      className="cursor-pointer hover:bg-neutral-wash"
                      onClick={() => setSelected(contact.email)}
                    >
                      <td className={td}>
                        <div className="font-medium text-ink">{contact.name || '—'}</div>
                        <div className="text-xs text-muted">{contact.email}</div>
                      </td>

                      <td className={td}>{CONTACT_SOURCE_LABELS[contact.source]}</td>

                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          {CONTACT_CHANNELS.map((channel) => (
                            <span
                              key={channel.value}
                              className={`rounded px-1.5 py-0.5 text-xs ring-1 ring-inset ${
                                contact.consent?.[channel.value]?.optIn
                                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                                  : 'bg-neutral-100 text-neutral-500 ring-neutral-400/20'
                              }`}
                              title={
                                contact.consent?.[channel.value]?.optIn
                                  ? `Opted in to ${channel.label}`
                                  : `Not opted in to ${channel.label}`
                              }
                            >
                              {channel.label}
                            </span>
                          ))}
                        </div>
                        <span className="sr-only">
                          {opted} of {total} channels opted in
                        </span>
                      </td>

                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          {contact.segments.length === 0 && (
                            /*
                              A contact with no orders gets no segment, and the
                              dash says so rather than leaving a blank cell
                              that reads as missing data. "No purchase history"
                              and "we failed to work it out" look identical
                              otherwise.
                            */
                            <span className="text-xs text-muted">No order history</span>
                          )}
                          {contact.segments.map((segment) => (
                            <span
                              key={segment}
                              className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${SEGMENT_STYLES[segment]}`}
                            >
                              {SEGMENT_LABELS[segment]}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          {contact.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-ink-2 ring-1 ring-inset ring-neutral-400/20"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {!loading && contacts.length > 0 && (
        <p className="text-xs text-muted">
          {contacts.length} contact{contacts.length === 1 ? '' : 's'}
          {filtered ? ' matching these filters' : ''}.{' '}
          {can.exportContacts
            ? 'The export downloads exactly this filtered view.'
            : 'Exporting the contact book is restricted to administrators.'}
        </p>
      )}

      {selected && (
        <ContactPanel
          email={selected}
          onClose={() => setSelected(null)}
          onChanged={reload}
          channelStatus={options?.channelStatus}
        />
      )}
    </div>
  );
}
