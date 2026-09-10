import { useMemo, useState } from 'react';
import { contactsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import { useToast } from '../../components/Toast';
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  ListEmptyState,
  PageHeader,
  Select,
  Table,
  TableSkeleton,
} from '../../components/common';
import ContactPanel from './ContactPanel';
import {
  CONTACT_CHANNELS,
  CONTACT_SOURCE_LABELS,
  SEGMENT_LABELS,
  SEGMENT_STYLES,
  consentCount,
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

/**
 * Up to two initials for the row avatar.
 *
 * Falls back to the email's first character, because a storefront guest can
 * reach this table with an address and no name at all — and a blank circle in
 * that row reads as a rendering fault rather than as missing data.
 */
function initialsFor(contact) {
  const words = String(contact?.name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return String(contact?.email || '?').slice(0, 1).toUpperCase();
}

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
    <div>
      <PageHeader
        eyebrow="Marketing"
        title="Contacts"
        subtitle="Everyone this business can reach — CRM customers, storefront buyers and guests, merged by email."
        action={
          /*
            ADMIN ONLY, and unchanged. The whole contact book in one file is a
            different thing from reading it a page at a time on screen, which
            is why it is gated separately from the list itself.
          */
          can.exportContacts && (
            <Button
              onClick={handleExport}
              loading={exporting}
              loadingLabel="Exporting…"
              disabled={!contacts.length}
            >
              Export to Excel
            </Button>
          )
        }
      />

      <ErrorBanner message={error} />

      {/* --- filter toolbar ---------------------------------------------- */}
      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field
            label="Search"
            placeholder="Name or email"
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
          />

          <Field label="Source">
            <Select value={filters.source} onChange={(e) => setFilter('source', e.target.value)}>
              <option value="">Any source</option>
              {(options?.sources || []).map((source) => (
                <option key={source} value={source}>
                  {CONTACT_SOURCE_LABELS[source] || source}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Segment">
            <Select value={filters.segment} onChange={(e) => setFilter('segment', e.target.value)}>
              <option value="">Any segment</option>
              {(options?.segments || []).map((segment) => (
                <option key={segment} value={segment}>
                  {SEGMENT_LABELS[segment] || segment}
                </option>
              ))}
            </Select>
          </Field>

          {/*
            The two halves of the opt-in filter, side by side and visibly
            paired. Split across the form they would look like independent
            controls, and setting one alone does nothing — which reads as a
            broken filter rather than an incomplete one.
          */}
          <Field label="Opt-in channel">
            <Select value={filters.channel} onChange={(e) => setFilter('channel', e.target.value)}>
              <option value="">Any channel</option>
              {CONTACT_CHANNELS.map((channel) => (
                <option key={channel.value} value={channel.value}>
                  {channel.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Opted in?"
            hint={!filters.channel ? 'Pick a channel first.' : undefined}
          >
            <Select
              value={filters.optedIn}
              onChange={(e) => setFilter('optedIn', e.target.value)}
              disabled={!filters.channel}
            >
              <option value="">Either</option>
              <option value="yes">Opted in</option>
              <option value="no">Not opted in</option>
            </Select>
          </Field>
        </div>

        {filtered && (
          <div className="mt-3 border-t border-hairline pt-3">
            <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      {/* --- the table ---------------------------------------------------- */}
      <Card className="overflow-hidden">
        {loading && <TableSkeleton rows={6} columns={5} />}

        {!loading && !contacts.length && (
          <ListEmptyState
            filtered={filtered}
            entity="contacts"
            onClear={() => setFilters(NO_FILTERS)}
          />
        )}

        {!loading && contacts.length > 0 && (
          <>
            <Table caption="Marketing contacts">
              <thead className="border-b border-hairline bg-plane">
                <tr>
                  <th className={th} scope="col">
                    Contact
                  </th>
                  <th className={th} scope="col">
                    Source
                  </th>
                  <th className={th} scope="col">
                    Opt-ins
                  </th>
                  <th className={th} scope="col">
                    Segments
                  </th>
                  <th className={th} scope="col">
                    Tags
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {contacts.map((contact) => {
                  const { opted, total } = consentCount(contact);

                  return (
                    <tr key={contact.email} className="transition-colors hover:bg-sunken">
                      <td className={td}>
                        {/*
                          A real button rather than a click handler on the row.
                          The row version opened by mouse and by nothing else —
                          no keyboard, no screen reader — and needed a pile of
                          role/tabIndex/onKeyDown scaffolding to imitate what
                          the element already does for free.
                        */}
                        <button
                          type="button"
                          onClick={() => setSelected(contact.email)}
                          className="flex items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                        >
                          <span
                            aria-hidden="true"
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-wash text-xs font-semibold text-brand-ink"
                          >
                            {initialsFor(contact)}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink">
                              {contact.name || '—'}
                            </span>
                            <span className="block truncate text-xs text-muted">
                              {contact.email}
                            </span>
                          </span>
                        </button>
                      </td>

                      <td className={td}>{CONTACT_SOURCE_LABELS[contact.source]}</td>

                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          {CONTACT_CHANNELS.map((channel) => {
                            const optedIn = Boolean(contact.consent?.[channel.value]?.optIn);

                            return (
                              <span
                                key={channel.value}
                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
                                  optedIn
                                    ? 'bg-good-wash text-good-ink ring-good/20'
                                    : 'bg-neutral-wash text-neutral-ink ring-rule/40'
                                }`}
                                title={
                                  optedIn
                                    ? `Opted in to ${channel.label}`
                                    : `Not opted in to ${channel.label}`
                                }
                              >
                                {/* A dot as well as the colour — the state is
                                    never carried by hue alone. */}
                                <span
                                  aria-hidden="true"
                                  className={`h-1.5 w-1.5 rounded-full ${
                                    optedIn ? 'bg-current' : 'bg-current opacity-35'
                                  }`}
                                />
                                {channel.label}
                              </span>
                            );
                          })}
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
                              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${SEGMENT_STYLES[segment]}`}
                            >
                              {SEGMENT_LABELS[segment]}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className={td}>
                        <div className="flex flex-wrap gap-1">
                          {contact.tags.length === 0 && (
                            <span className="text-xs text-muted">—</span>
                          )}
                          {contact.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-2 ring-1 ring-inset ring-rule/40"
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
            </Table>

            <div className="border-t border-hairline px-4 py-3">
              <p className="text-xs text-muted">
                <span className="tabular font-medium text-ink-2">{contacts.length}</span> contact
                {contacts.length === 1 ? '' : 's'}
                {filtered ? ' matching these filters' : ''}.{' '}
                {can.exportContacts
                  ? 'The export downloads exactly this filtered view.'
                  : 'Exporting the contact book is restricted to administrators.'}
              </p>
            </div>
          </>
        )}
      </Card>

      {/*
        Mounted only while a contact is chosen, so the panel's own fetch is
        never issued for a null email — the same condition this screen has
        always used, kept rather than folded into the Drawer's `open` prop.
      */}
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
