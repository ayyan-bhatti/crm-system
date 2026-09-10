import { useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../api/resources';
import { errorMessage } from '../api/client';
import { Button, Card, ErrorBanner, Field, useFormValidation, validators } from '../components/common';
import { link } from '../ui';
import AuthLayout, { StatusRegion } from './AuthLayout';

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
const RULES = { email: validators.email };

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { visibleErrors, markTouched, validate } = useFormValidation(RULES);
  const errors = visibleErrors({ email });

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validate({ email })) return;

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
    <AuthLayout
      eyebrow="Password reset"
      title={submitted ? 'Check your inbox' : 'Reset your password'}
      subtitle={
        submitted
          ? 'The same message appears whether or not the address has an account — that is deliberate.'
          : 'We will email you a link to choose a new one.'
      }
      footer={
        <>
          Remembered it?{' '}
          <Link to="/crm/login" className={link}>
            Sign in
          </Link>
        </>
      }
    >
      <Card className="p-6 shadow-lift sm:p-7">
        {submitted ? (
          <div aria-live="polite">
            <div className="flex items-start gap-3 rounded-lg border border-good/25 bg-good-wash px-4 py-3 text-sm text-good-ink">
              <svg
                viewBox="0 0 20 20"
                className="mt-0.5 h-4 w-4 shrink-0 fill-current"
                aria-hidden="true"
              >
                <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm4 6.2l-4.7 4.7a1 1 0 01-1.42 0L6 11.02l1.42-1.42 1.17 1.18 4-4L14 8.2z" />
              </svg>
              <p>
                If an account exists for{' '}
                <span className="font-semibold break-words">{email}</span>, a reset link is on its
                way. It expires in 30 minutes.
              </p>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-muted">
              Nothing arrived? Check the address for typos, and look in your spam folder.
            </p>
          </div>
        ) : (
          <>
            <StatusRegion>
              <ErrorBanner message={error} />
            </StatusRegion>

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <Field
                label="Email address"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="name@example.com"
                required
                value={email}
                error={errors.email}
                onBlur={() => markTouched('email')}
                onChange={(event) => setEmail(event.target.value)}
              />

              <Button
                type="submit"
                className="w-full"
                loading={submitting}
                loadingLabel="Sending…"
              >
                Send reset link
              </Button>
            </form>
          </>
        )}
      </Card>
    </AuthLayout>
  );
}
