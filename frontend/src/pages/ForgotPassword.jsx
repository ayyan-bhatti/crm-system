import { useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../api/resources';
import { errorMessage } from '../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../components/common';
import { btnPrimary, link } from '../ui';

/**
 * "I forgot my password."
 *
 * THE SCREEN DELIBERATELY DOES NOT SAY WHETHER THE ACCOUNT EXISTS.
 *
 * The API answers identically either way — telling the user "no account with
 * that email" would be a free account-enumeration oracle — and this screen has
 * to hold that line, or the defence is undone at the last step. So a successful
 * request always shows the same confirmation.
 *
 * The wording carries the weight instead: "if an account exists" is honest
 * about the uncertainty rather than implying a mail is definitely on its way,
 * and the note about checking the address covers the mistyped-email case
 * without confirming anything.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      await authApi.forgotPassword(email);
      setSubmitted(true);
    } catch (err) {
      // Only a genuine failure (rate limited, server down) lands here — a
      // missing account is a success as far as this endpoint is concerned.
      setError(errorMessage(err, 'Could not send the reset link'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Reset your password</h1>
          <p className="mt-1.5 text-sm text-ink-2">
            We will email you a link to choose a new one.
          </p>
        </div>

        <Card className="p-6 shadow-lift">
          {submitted ? (
            <div className="text-center">
              <p className="text-sm font-medium text-ink">Check your inbox</p>
              <p className="mt-2 text-sm text-ink-2">
                If an account exists for <span className="font-medium text-ink">{email}</span>, a
                reset link is on its way. It expires in 30 minutes.
              </p>
              <p className="mt-3 text-xs text-muted">
                Nothing arrived? Check the address for typos, and look in your spam folder.
              </p>
            </div>
          ) : (
            <>
              <ErrorBanner message={error} />

              <form onSubmit={handleSubmit} className="space-y-4">
                <Field
                  label="Email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />

                <button type="submit" className={`${btnPrimary} w-full`} disabled={submitting}>
                  {submitting ? <Spinner /> : 'Send reset link'}
                </button>
              </form>
            </>
          )}
        </Card>

        <p className="mt-5 text-center text-sm text-ink-2">
          Remembered it?{' '}
          <Link to="/crm/login" className={link}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
