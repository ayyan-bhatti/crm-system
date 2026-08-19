import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiSearchBar from './AiSearchBar';
import { renderWithProviders, fakeUser, apiError } from '../test/utils';
import { authApi, aiSearchApi } from '../api/resources';

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
}));

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
