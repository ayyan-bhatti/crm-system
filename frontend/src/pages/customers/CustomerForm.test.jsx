import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomerForm from './CustomerForm';
import { renderWithProviders, fakeUser, apiError } from '../../test/utils';
import { authApi, customersApi, usersApi } from '../../api/resources';

/**
 * The customer create/edit form.
 *
 * One component serves both, decided by whether the route has an `:id`. That is
 * the interesting part to test: the two modes must send different requests and
 * — the easy thing to get wrong — the edit mode must actually load the existing
 * record into the fields before the user can change anything.
 */
vi.mock('../../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  customersApi: { get: vi.fn(), create: vi.fn(), update: vi.fn() },
  usersApi: { assignable: vi.fn() },
}));

const existingCustomer = {
  _id: '650000000000000000000099',
  name: 'Karachi Traders',
  email: 'contact@karachitraders.com',
  phone: '0300 1234567',
  company: 'Karachi Traders Ltd',
  city: 'Karachi',
  status: 'active',
  notes: 'Prefers email contact.',
  assignedTo: null,
};

describe('CustomerForm', () => {
  beforeEach(() => {
    authApi.me.mockResolvedValue(fakeUser());
    usersApi.assignable.mockResolvedValue([fakeUser()]);
  });

  describe('creating', () => {
    it('sends what was typed', async () => {
      const user = userEvent.setup();
      customersApi.create.mockResolvedValue({ ...existingCustomer, _id: 'new-id' });

      renderWithProviders(<CustomerForm />, { route: '/customers/new', guarded: true });

      await user.type(await screen.findByLabelText(/^name/i), 'Karachi Traders');
      await user.type(screen.getByLabelText(/email/i), 'contact@karachitraders.com');
      await user.type(screen.getByLabelText(/city/i), 'Karachi');

      await user.click(screen.getByRole('button', { name: /create|save/i }));

      await waitFor(() => expect(customersApi.create).toHaveBeenCalled());

      expect(customersApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Karachi Traders',
          email: 'contact@karachitraders.com',
          city: 'Karachi',
        })
      );
    });

    it('does not try to load a record it does not have', async () => {
      renderWithProviders(<CustomerForm />, { route: '/customers/new', guarded: true });

      await screen.findByLabelText(/^name/i);
      expect(customersApi.get).not.toHaveBeenCalled();
    });

    /**
     * A validation failure has to be visible. The API returns per-field
     * messages in `details`, and the app's errorMessage helper joins them —
     * showing nothing would leave the user pressing a button that appears to do
     * nothing at all.
     */
    it('shows the server’s validation message', async () => {
      const user = userEvent.setup();
      customersApi.create.mockRejectedValue(
        apiError(400, 'Validation failed', { email: 'Please provide a valid email address' })
      );

      renderWithProviders(<CustomerForm />, { route: '/customers/new', guarded: true });

      await user.type(await screen.findByLabelText(/^name/i), 'Karachi Traders');
      await user.type(screen.getByLabelText(/email/i), 'not-an-email@x.co');
      await user.click(screen.getByRole('button', { name: /create|save/i }));

      expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
    });

    it('re-enables the submit button after a failure', async () => {
      const user = userEvent.setup();
      customersApi.create.mockRejectedValue(apiError(400, 'Validation failed'));

      renderWithProviders(<CustomerForm />, { route: '/customers/new', guarded: true });

      await user.type(await screen.findByLabelText(/^name/i), 'Acme');
      await user.type(screen.getByLabelText(/email/i), 'a@b.co');

      const submit = screen.getByRole('button', { name: /create|save/i });
      await user.click(submit);

      await screen.findByText(/validation failed/i);
      await waitFor(() => expect(submit).not.toBeDisabled());
    });
  });

  describe('editing', () => {
    beforeEach(() => {
      customersApi.get.mockResolvedValue(existingCustomer);
    });

    /** The bug this guards against: an edit form that opens blank and wipes the record. */
    it('loads the existing values into the fields', async () => {
      renderWithProviders(<CustomerForm />, {
        route: `/customers/${existingCustomer._id}/edit`,
        path: '/customers/:id/edit',
        guarded: true,
      });

      expect(await screen.findByDisplayValue('Karachi Traders')).toBeInTheDocument();
      expect(screen.getByDisplayValue('contact@karachitraders.com')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Karachi')).toBeInTheDocument();
    });

    it('updates rather than creating', async () => {
      const user = userEvent.setup();
      customersApi.update.mockResolvedValue(existingCustomer);

      renderWithProviders(<CustomerForm />, {
        route: `/customers/${existingCustomer._id}/edit`,
        path: '/customers/:id/edit',
        guarded: true,
      });

      const nameField = await screen.findByDisplayValue('Karachi Traders');
      await user.clear(nameField);
      await user.type(nameField, 'Karachi Traders International');

      await user.click(screen.getByRole('button', { name: /save|update/i }));

      await waitFor(() => expect(customersApi.update).toHaveBeenCalled());

      expect(customersApi.update).toHaveBeenCalledWith(
        existingCustomer._id,
        expect.objectContaining({ name: 'Karachi Traders International' })
      );
      expect(customersApi.create).not.toHaveBeenCalled();
    });

    it('reports a record it cannot load', async () => {
      customersApi.get.mockRejectedValue(apiError(404, 'Customer not found'));

      renderWithProviders(<CustomerForm />, {
        route: '/customers/650000000000000000000404/edit',
        path: '/customers/:id/edit',
        guarded: true,
      });

      expect(await screen.findByText(/customer not found/i)).toBeInTheDocument();
    });
  });
});
