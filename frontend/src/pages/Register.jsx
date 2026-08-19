import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../components/common';
import { btnPrimary, link } from '../ui';

export default function Register() {
  const { register, isAuthenticated, loading: sessionLoading } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (sessionLoading) return <Spinner full />;
  if (isAuthenticated) return <Navigate to="/" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      await register(form);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Unable to create account'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">SimpleCRM</h1>
          <p className="mt-1 text-sm text-muted">Create your account</p>
        </div>

        <Card className="p-6">
          <ErrorBanner message={error} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              // Stating the rule up front is worth more than a good error
              // message: nobody enjoys discovering a policy one rejection at a
              // time. The server is still the enforcement — see
              // backend/src/utils/passwordPolicy.js — this is just the hint.
              hint="At least 10 characters, mixing letters, numbers and symbols — or a phrase of 14+ characters."
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />

            <button type="submit" className={`${btnPrimary} w-full`} disabled={submitting}>
              {submitting ? <Spinner /> : 'Create account'}
            </button>
          </form>

          {/*
            Worth stating plainly, since it surprises people: the role is
            decided by the server, not chosen here. The very first account on a
            fresh install becomes the admin; everyone after that is a sales rep
            until an admin promotes them.
          */}
          <p className="mt-4 text-xs text-muted">
            The first account created becomes the administrator. Later sign-ups are sales reps
            until an administrator changes their role.
          </p>
        </Card>

        <p className="mt-4 text-center text-sm text-muted">
          Already have an account?{' '}
          <Link to="/login" className={link}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
