import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, apiError } from '../test/utils';
import { activityApi, authApi } from '../api/resources';
import ActivityTimeline from './ActivityTimeline';

vi.mock('../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  activityApi: { list: vi.fn(), add: vi.fn() },
}));

const note = (overrides = {}) => ({
  _id: overrides._id || 'n-1',
  body: overrides.body || 'Rang about the March order.',
  createdAt: overrides.createdAt || '2026-03-14T09:30:00.000Z',
  author: overrides.author || { name: 'Sara Iqbal', role: 'sales_rep' },
});

beforeEach(() => {
  vi.clearAllMocks();
  authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
  activityApi.list.mockResolvedValue([]);
});

describe('ActivityTimeline', () => {
  it('shows each note with who wrote it and when', async () => {
    activityApi.list.mockResolvedValue([
      note({ _id: 'n-2', body: 'Chased the invoice, no answer.' }),
      note({ _id: 'n-1', body: 'Rang about the March order.' }),
    ]);

    renderWithProviders(<ActivityTimeline entity="customer" id="c-1" />);

    expect(await screen.findByText('Chased the invoice, no answer.')).toBeInTheDocument();
    expect(screen.getByText('Rang about the March order.')).toBeInTheDocument();
    expect(screen.getAllByText('Sara Iqbal')).toHaveLength(2);
    expect(screen.getAllByText('Sales rep')).toHaveLength(2);
  });

  it('reads the timeline for the record it was given', async () => {
    renderWithProviders(<ActivityTimeline entity="order" id="o-7" />);

    await waitFor(() => expect(activityApi.list).toHaveBeenCalledWith('order', 'o-7'));
  });

  it('says so when there is nothing recorded yet', async () => {
    renderWithProviders(<ActivityTimeline entity="customer" id="c-1" />);

    expect(await screen.findByText(/nothing recorded yet/i)).toBeInTheDocument();
  });

  it('adds a note and shows the updated timeline', async () => {
    const user = userEvent.setup();
    activityApi.add.mockResolvedValue(note({ _id: 'n-9', body: 'Agreed the discount.' }));

    renderWithProviders(<ActivityTimeline entity="customer" id="c-1" />);
    await screen.findByText(/nothing recorded yet/i);

    activityApi.list.mockResolvedValue([note({ _id: 'n-9', body: 'Agreed the discount.' })]);

    await user.type(screen.getByLabelText(/add a note/i), 'Agreed the discount.');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    expect(activityApi.add).toHaveBeenCalledWith('customer', 'c-1', 'Agreed the discount.');
    expect(await screen.findByText('Agreed the discount.')).toBeInTheDocument();
  });

  /** An empty or whitespace-only note is not a note. */
  it('will not submit an empty note', async () => {
    const user = userEvent.setup();

    renderWithProviders(<ActivityTimeline entity="customer" id="c-1" />);
    await screen.findByText(/nothing recorded yet/i);

    const button = screen.getByRole('button', { name: /add note/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/add a note/i), '   ');
    expect(button).toBeDisabled();
    expect(activityApi.add).not.toHaveBeenCalled();
  });

  /*
   * A note is often the only copy of what was just said on a call. Clearing the
   * box before the write has succeeded throws it away on the one occasion it
   * mattered.
   */
  it('keeps what was typed when saving fails', async () => {
    const user = userEvent.setup();
    activityApi.add.mockRejectedValue(apiError(500, 'Database unavailable'));

    renderWithProviders(<ActivityTimeline entity="customer" id="c-1" />);
    await screen.findByText(/nothing recorded yet/i);

    const box = screen.getByLabelText(/add a note/i);
    await user.type(box, 'They are furious about the delay.');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    expect(await screen.findByText(/database unavailable/i)).toBeInTheDocument();
    expect(box).toHaveValue('They are furious about the delay.');
  });

  it('surfaces a failure to load the timeline', async () => {
    activityApi.list.mockRejectedValue(apiError(403, 'You do not have access to this order'));

    renderWithProviders(<ActivityTimeline entity="order" id="o-1" />);

    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument();
  });

  /*
   * APPEND-ONLY, AS A PROPERTY OF THE SCREEN.
   *
   * No edit control, no delete control, and the reason stated on the page —
   * because a missing button reads as unfinished software unless the interface
   * says the absence is deliberate.
   */
  it('offers no way to edit or delete a note, and says why', async () => {
    activityApi.list.mockResolvedValue([note()]);

    renderWithProviders(<ActivityTimeline entity="customer" id="c-1" />);
    await screen.findByText('Rang about the March order.');

    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be edited or removed/i)).toBeInTheDocument();
  });
});
