import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../api/client';
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Select,
  Spinner,
  useFormValidation,
  validators,
} from '../components/common';
import { REQUESTABLE_ROLES } from '../constants';
import { humanize, link } from '../ui';
import AuthLayout, { PasswordField, StatusRegion } from './AuthLayout';

/**
 * Ask for an account.
 *
 * NOT A REGISTRATION, AND THE PAGE SAYS SO THROUGHOUT.
 *
 * Submitting creates an account that cannot be used until an administrator
 * approves it. That is the single most important thing for this page to
 * communicate, because the failure mode if it does not is somebody filling in a
 * form, being told "success", and then being unable to sign in with no idea
 * why. So the heading, the button and the confirmation all say "request".
 *
 * There is no redirect on success and no session — see the note on `register`
 * in AuthContext. The page swaps itself for a confirmation instead, which is
 * the honest end of the flow: there is nowhere to go yet.
 */
const RULES = {
  name: validators.required('Name'),
  email: validators.email,
  password: validators.password,
};

export default function Register() {
  const { register, isAuthenticated, loading: sessionLoading } = useAuth();

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    requestedRole: 'sales_rep',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * What the server said, once the request is in. Held rather than shown as a
   * toast: a toast disappears, and this is the only place the person is told
   * that nothing further will happen until somebody acts.
   */
  const [submitted, setSubmitted] = useState(null);

  const { visibleErrors, markTouched, validate } = useFormValidation(RULES);
  const errors = visibleErrors(form);

  if (sessionLoading) return <Spinner full />;
  if (isAuthenticated) return <Navigate to="/crm" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validate(form)) return;

    setSubmitting(true);
    setError('');

    try {
      const result = await register(form);
      setSubmitted(result);
    } catch (err) {
      setError(errorMessage(err, 'Unable to send your request'));
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <AuthLayout
        eyebrow="Request an account"
        title="Request sent"
        subtitle="Nothing else happens on your side until an administrator acts."
        footer={
          <Link to="/crm/login" className={link}>
            Back to sign in
          </Link>
        }
      >
        <Card className="p-6 shadow-lift sm:p-7">
          <div className="flex items-start gap-3 rounded-lg border border-good/25 bg-good-wash px-4 py-3 text-sm text-good-ink">
            <svg
              viewBox="0 0 20 20"
              className="mt-0.5 h-4 w-4 shrink-0 fill-current"
              aria-hidden="true"
            >
              <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm4 6.2l-4.7 4.7a1 1 0 01-1.42 0L6 11.02l1.42-1.42 1.17 1.18 4-4L14 8.2z" />
            </svg>
            <p>
              {submitted.message ||
                'Your request has been sent to an administrator. You will be able to sign in once it has been approved.'}
            </p>
          </div>

          {/*
            Stated plainly because it is the thing people get wrong: the
            password is already set, so there is nothing else to do and no
            second email to wait for beyond the decision itself.
          */}
          <p className="mt-4 text-sm leading-relaxed text-ink-2">
            Sign in with the password you just chose — once your request has been approved, it will
            simply start working.
          </p>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow="Request an account"
      title="Ask for access"
      subtitle="An administrator reviews every request before the account can be used."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/crm/login" className={link}>
            Sign in
          </Link>
        </>
      }
    >
      <Card className="p-6 shadow-lift sm:p-7">
        <StatusRegion>
          <ErrorBanner message={error} />
        </StatusRegion>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <Field
            label="Name"
            autoComplete="name"
            placeholder="Bilal Ahmed"
            required
            value={form.name}
            error={errors.name}
            onBlur={() => markTouched('name')}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />

          <Field
            label="Email address"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="name@example.com"
            required
            value={form.email}
            error={errors.email}
            onBlur={() => markTouched('email')}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />

          {/*
            Administrator is not in this list, and cannot be added to it by
            editing the request: the API validates against the same set and
            refuses outright rather than quietly downgrading, so somebody
            cannot come away believing they asked for admin and got it.
          */}
          <Field
            label="Role you are requesting"
            hint="An administrator decides what you are actually granted."
          >
            <Select
              value={form.requestedRole}
              onChange={(event) => setForm({ ...form, requestedRole: event.target.value })}
            >
              {REQUESTABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {humanize(role)}
                </option>
              ))}
            </Select>
          </Field>

          <PasswordField
            label="Password"
            autoComplete="new-password"
            placeholder="At least 10 characters"
            required
            minLength={10}
            // Stating the rule up front is worth more than a good error
            // message: nobody enjoys discovering a policy one rejection at a
            // time. The server is still the enforcement — see
            // backend/src/utils/passwordPolicy.js — this is just the hint.
            hint="At least 10 characters, mixing letters, numbers and symbols — or a phrase of 14+ characters."
            value={form.password}
            error={errors.password}
            onBlur={() => markTouched('password')}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />

          <Button
            type="submit"
            className="w-full"
            loading={submitting}
            loadingLabel="Sending request…"
          >
            Send request
          </Button>
        </form>

        <p className="mt-4 border-t border-hairline pt-4 text-xs leading-relaxed text-muted">
          Your account is created straight away but cannot be used until an administrator approves
          it. You will not be signed in yet.
        </p>
      </Card>
    </AuthLayout>
  );
}
