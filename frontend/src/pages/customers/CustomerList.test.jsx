import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomerList from './CustomerList';
import { renderWithProviders, fakeUser } from '../../test/utils';
import { authApi, customersApi, usersApi } from '../../api/resources';

/**
 * The Excel import panel: who gets it, and that it actually calls through to
 * `customersApi.importFile` and reports what came back — created, skipped,
 * and failed rows are all real, expected outcomes of importing a real
 * spreadsheet, not error states, so the summary has to show all three.
 */

vi.mock('../../api/resources', () => ({
  customersApi: {
    list: vi.fn(),
    churnRollup: vi.fn(),
    importFile: vi.fn(),
  },
  usersApi: { assignable: vi.fn() },
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
}));

const EMPTY_LIST = { data: [], page: 1, pages: 1, total: 0 };

function renderAs(role) {
  authApi.me.mockResolvedValue(fakeUser({ role }));
  customersApi.list.mockResolvedValue(EMPTY_LIST);
  customersApi.churnRollup.mockResolvedValue({ data: { rollup: [], narrative: '' } });
  usersApi.assignable.mockResolvedValue([]);

  return renderWithProviders(<CustomerList />, { guarded: true });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the import button', () => {
  it('is offered to an admin', async () => {
    renderAs('admin');

    expect(await screen.findByRole('button', { name: /import from excel/i })).toBeInTheDocument();
  });

  it('is not offered to a manager or a sales rep', async () => {
    renderAs('manager');

    await screen.findByRole('heading', { name: /customers/i });
    expect(screen.queryByRole('button', { name: /import from excel/i })).not.toBeInTheDocument();
  });

  it('uploads the chosen file and shows a mixed result honestly', async () => {
    const user = userEvent.setup();
    customersApi.importFile.mockResolvedValue({
      created: [{ row: 2, email: 'new@example.com' }],
      skipped: [{ row: 3, email: 'existing@example.com', reason: 'A customer with this email already exists' }],
      failed: [{ row: 4, email: '', reason: 'Missing name' }],
      totalRows: 3,
    });

    renderAs('admin');

    await user.click(await screen.findByRole('button', { name: /import from excel/i }));

    const file = new File(['irrelevant'], 'customers.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const fileInput = screen.getByLabelText(/customer spreadsheet/i);
    await user.upload(fileInput, file);

    await user.click(screen.getByRole('button', { name: /upload and import/i }));

    await waitFor(() => {
      expect(customersApi.importFile).toHaveBeenCalledWith(file);
    });

    expect(await screen.findByText(/1 of 3 rows created, 1 skipped, 1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/existing@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/Missing name/)).toBeInTheDocument();
  });

  it('refreshes the customer list once a row was actually created', async () => {
    const user = userEvent.setup();
    customersApi.importFile.mockResolvedValue({
      created: [{ row: 2, email: 'new@example.com' }],
      skipped: [],
      failed: [],
      totalRows: 1,
    });

    renderAs('admin');
    await screen.findByRole('heading', { name: /customers/i });
    const callsBeforeUpload = customersApi.list.mock.calls.length;

    await user.click(await screen.findByRole('button', { name: /import from excel/i }));
    const file = new File(['irrelevant'], 'customers.xlsx');
    await user.upload(screen.getByLabelText(/customer spreadsheet/i), file);
    await user.click(screen.getByRole('button', { name: /upload and import/i }));

    await waitFor(() => {
      expect(customersApi.list.mock.calls.length).toBeGreaterThan(callsBeforeUpload);
    });
  });
});
