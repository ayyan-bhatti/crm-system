import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiSearchBar from './AiSearchBar';
import { renderWithProviders, fakeUser, apiError } from '../test/utils';
import { authApi, aiSearchApi, internalApi } from '../api/resources';

/**
 * Natural-language search.
 *
 * The behaviour worth testing here is not "does it call the endpoint" — it is
 * that the UI is HONEST about what produced the results. The endpoint answers in
 * two modes, and a user shown keyword results styled as AI results has no way
 * to tell a precise answer from a rough one.
 *
 * The AI itself is never involved: the API module is mocked, so these tests are
 * deterministic and cost nothing to run.
 */
vi.mock('../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  aiSearchApi: { search: vi.fn() },
  internalApi: { aiStatus: vi.fn() },
}));

/** The status probe fires on mount for admins; default it for every test. */
const CONFIGURED = { configured: true, keyPresent: true, mode: 'ai', summary: 'AI is configured and working.' };

const aiResult = {
  success: true,
  mode: 'ai',
  entity: 'customer',
  count: 1,
  filter: {
    entity: 'customer',
    conditions: [{ field: 'city', operator: 'contains', value: 'Karachi' }],
  },
  data: [
    {
      _id: '650000000000000000000011',
      name: 'Karachi Traders',
      email: 'contact@kt.com',
      city: 'Karachi',
      status: 'active',
    },
  ],
};

const fallbackResult = {
  ...aiResult,
  mode: 'fallback',
  reason: 'ANTHROPIC_API_KEY is not configured',
  filter: null,
};

describe('AiSearchBar', () => {
  beforeEach(() => {
    authApi.me.mockResolvedValue(fakeUser());
  });

  it('sends the typed question to the search endpoint', async () => {
    const user = userEvent.setup();
    aiSearchApi.search.mockResolvedValue(aiResult);

    renderWithProviders(<AiSearchBar />);

    const box = await screen.findByRole('textbox');
    await user.type(box, 'customers in Karachi');
    await user.click(screen.getByRole('button', { name: /search|ask/i }));

    await waitFor(() =>
      expect(aiSearchApi.search).toHaveBeenCalledWith('customers in Karachi')
    );
  });

  it('renders the matching records', async () => {
    const user = userEvent.setup();
    aiSearchApi.search.mockResolvedValue(aiResult);

    renderWithProviders(<AiSearchBar />);

    await user.type(await screen.findByRole('textbox'), 'customers in Karachi');
    await user.click(screen.getByRole('button', { name: /search|ask/i }));

    expect(await screen.findByText('Karachi Traders')).toBeInTheDocument();
  });

  /**
   * The honesty requirement. A keyword search and an AI search return the same
   * shape, so without a visible mode the user cannot tell which they got — and
   * would over-trust a rough answer.
   */
  it('says when the answer came from the AI path', async () => {
    const user = userEvent.setup();
    aiSearchApi.search.mockResolvedValue(aiResult);

    renderWithProviders(<AiSearchBar />);

    await user.type(await screen.findByRole('textbox'), 'customers in Karachi');
    await user.click(screen.getByRole('button', { name: /search|ask/i }));

    await screen.findByText('Karachi Traders');
    expect(screen.getByText(/\bAI\b/i)).toBeInTheDocument();
  });

  it('says when it fell back to keyword search', async () => {
    const user = userEvent.setup();
    aiSearchApi.search.mockResolvedValue(fallbackResult);

    renderWithProviders(<AiSearchBar />);

    await user.type(await screen.findByRole('textbox'), 'customers in Karachi');
    await user.click(screen.getByRole('button', { name: /search|ask/i }));

    await screen.findByText('Karachi Traders');
    // "keyword" appears both in the mode badge and in the explanation beneath
    // it, which is the intended design — so this asserts it is shown at all
    // rather than that it is shown exactly once.
    expect(screen.getAllByText(/keyword/i).length).toBeGreaterThan(0);
  });

  /**
   * A fallback still returns results, so this must not look like a failure.
   * Degrading quietly-but-visibly is the whole design of the endpoint.
   */
  it('still shows results when the AI path was unavailable', async () => {
    const user = userEvent.setup();
    aiSearchApi.search.mockResolvedValue(fallbackResult);

    renderWithProviders(<AiSearchBar />);

    await user.type(await screen.findByRole('textbox'), 'customers in Karachi');
    await user.click(screen.getByRole('button', { name: /search|ask/i }));

    expect(await screen.findByText('Karachi Traders')).toBeInTheDocument();
  });

  it('reports an outright failure', async () => {
    const user = userEvent.setup();
    aiSearchApi.search.mockRejectedValue(apiError(500, 'Search failed'));

    renderWithProviders(<AiSearchBar />);

    await user.type(await screen.findByRole('textbox'), 'customers in Karachi');
    await user.click(screen.getByRole('button', { name: /search|ask/i }));

    expect(await screen.findByText(/search failed/i)).toBeInTheDocument();
  });

  /** Rate limiting is a normal outcome on this endpoint, so its message must land. */
  it('shows the rate-limit message', async () => {
    const user = userEvent.setup();
    aiSearchApi.search.mockRejectedValue(
      apiError(429, 'Too many AI searches. Please wait a moment before searching again.')
    );

    renderWithProviders(<AiSearchBar />);

    await user.type(await screen.findByRole('textbox'), 'anything');
    await user.click(screen.getByRole('button', { name: /search|ask/i }));

    expect(await screen.findByText(/too many ai searches/i)).toBeInTheDocument();
  });

  it('does not search on an empty question', async () => {
    const user = userEvent.setup();

    renderWithProviders(<AiSearchBar />);

    await screen.findByRole('textbox');
    await user.click(screen.getByRole('button', { name: /search|ask/i }));

    expect(aiSearchApi.search).not.toHaveBeenCalled();
  });

  /** The example prompts are the fastest way to understand what the box accepts. */
  it('runs an example when one is clicked', async () => {
    const user = userEvent.setup();
    aiSearchApi.search.mockResolvedValue(aiResult);

    renderWithProviders(<AiSearchBar />);

    await screen.findByRole('textbox');
    await user.click(screen.getByText(/customers in Karachi with no orders/i));

    await waitFor(() => expect(aiSearchApi.search).toHaveBeenCalled());
  });
});

/**
 * The admin-only "AI is not configured" notice.
 *
 * This exists because of a real production failure: ANTHROPIC_API_KEY was never
 * set, so this box ran a plain keyword search, returned results, and said "AI
 * search" above them. Nothing was red and nothing said otherwise, so the
 * deployment stayed in that state indefinitely.
 *
 * The per-search badge reports what ONE search did. This reports what the
 * system will keep doing until someone acts.
 */
describe('AI configuration notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiSearchApi.search.mockResolvedValue(aiResult);
  });

  const renderAs = (role) => {
    authApi.me.mockResolvedValue(fakeUser({ role }));
    return renderWithProviders(<AiSearchBar />, { guarded: true });
  };

  it('warns an admin when the key is not configured', async () => {
    internalApi.aiStatus.mockResolvedValue({
      configured: false,
      keyPresent: false,
      mode: 'fallback',
      summary: 'ANTHROPIC_API_KEY is not set. Every AI feature is falling back.',
    });
    renderAs('admin');

    expect(await screen.findByText(/ai is not configured/i)).toBeInTheDocument();
    // Named twice on purpose: once in the summary, once as the literal
    // variable to set. Both are useful, so assert on the count rather than
    // pretending only one exists.
    expect(screen.getAllByText(/ANTHROPIC_API_KEY/).length).toBeGreaterThan(0);
  });

  /** A green "all fine" badge on every screen is how people stop reading badges. */
  it('says nothing when the AI is working', async () => {
    internalApi.aiStatus.mockResolvedValue(CONFIGURED);
    renderAs('admin');

    await waitFor(() => expect(internalApi.aiStatus).toHaveBeenCalled());
    expect(screen.queryByText(/ai is not configured/i)).not.toBeInTheDocument();
  });

  /**
   * A sales rep cannot set an environment variable, and the endpoint is
   * admin-only anyway — asking would be a guaranteed 403 on every dashboard.
   */
  it('does not probe or warn for a non-admin', async () => {
    internalApi.aiStatus.mockResolvedValue({ configured: false, summary: 'not set' });
    renderAs('sales_rep');

    expect(await screen.findByPlaceholderText(/customers in Karachi/i)).toBeInTheDocument();
    expect(internalApi.aiStatus).not.toHaveBeenCalled();
    expect(screen.queryByText(/ai is not configured/i)).not.toBeInTheDocument();
  });

  /** A broken diagnostic must not put an error banner on a working search box. */
  it('stays silent when the status probe itself fails', async () => {
    internalApi.aiStatus.mockRejectedValue(new Error('boom'));
    renderAs('admin');

    expect(await screen.findByPlaceholderText(/customers in Karachi/i)).toBeInTheDocument();
    expect(screen.queryByText(/ai is not configured/i)).not.toBeInTheDocument();
  });
});
