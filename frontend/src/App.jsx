import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import DashboardLayout from './components/DashboardLayout';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { Spinner } from './components/common';

import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import AcceptInvite from './pages/AcceptInvite';

import { PRODUCT_WRITE_ROLES, ROLES } from './constants';

/**
 * Route table.
 *
 * Two public routes; everything else sits inside <ProtectedRoute>, which also
 * renders the shared dashboard shell. Where a route is limited to certain roles
 * (product editing, user management) the `roles` prop redirects anyone else
 * home — the API enforces the same rules, so this is about not showing people
 * screens they cannot use.
 *
 * CODE SPLITTING: the authenticated pages are lazy-loaded, the two auth pages
 * are not. The charting library alone is most of the app's JavaScript, and
 * bundling it with the login screen means every visitor downloads it before
 * they can type a password. Splitting at the route boundary lets each page
 * arrive when it is actually needed.
 *
 * Note "/customers/new" is declared before "/customers/:id", otherwise "new"
 * would be captured as an id.
 */

const Dashboard = lazy(() => import('./pages/Dashboard'));

const CustomerList = lazy(() => import('./pages/customers/CustomerList'));
const CustomerDetail = lazy(() => import('./pages/customers/CustomerDetail'));
const CustomerForm = lazy(() => import('./pages/customers/CustomerForm'));

const ProductList = lazy(() => import('./pages/products/ProductList'));
const ProductDetail = lazy(() => import('./pages/products/ProductDetail'));
const ProductForm = lazy(() => import('./pages/products/ProductForm'));

const OrderList = lazy(() => import('./pages/orders/OrderList'));
const OrderDetail = lazy(() => import('./pages/orders/OrderDetail'));
const OrderForm = lazy(() => import('./pages/orders/OrderForm'));

const UserList = lazy(() => import('./pages/users/UserList'));
const AuditLog = lazy(() => import('./pages/AuditLog'));
const Account = lazy(() => import('./pages/Account'));

export default function App() {
  return (
    <BrowserRouter>
      {/*
        The outermost boundary. React unmounts the ENTIRE tree on an uncaught
        render error, so without this one broken component leaves a blank white
        page with no navigation and no way back — indistinguishable, to the
        user, from the site being down.
      */}
      <ErrorBoundary>
        <ToastProvider>
          <AuthProvider>
            {/* One boundary around the routes: a lazy page resolves in
                milliseconds on a warm connection, so a full-page spinner is all
                this needs. */}
            <Suspense fallback={<Spinner full />}>
              <Routes>
                {/* --- Public ----------------------------------------------- */}
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                {/* Not lazy-loaded: someone locked out of their account is the
                    last person who should wait for a chunk to download. */}
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                {/* Public: the invitee has no account to authenticate with
                    until they have been through this page. */}
                <Route path="/accept-invite" element={<AcceptInvite />} />

                {/* --- Authenticated ---------------------------------------- */}
                <Route
                  element={
                    <ProtectedRoute>
                      <DashboardLayout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<Dashboard />} />

              {/* Every signed-in user has one, whatever their role. */}
              <Route path="account" element={<Account />} />

                  <Route path="customers">
                    <Route index element={<CustomerList />} />
                    <Route path="new" element={<CustomerForm />} />
                    <Route path=":id" element={<CustomerDetail />} />
                    <Route path=":id/edit" element={<CustomerForm />} />
                  </Route>

                  <Route path="products">
                    <Route index element={<ProductList />} />
                    <Route
                      path="new"
                      element={
                        <ProtectedRoute roles={PRODUCT_WRITE_ROLES}>
                          <ProductForm />
                        </ProtectedRoute>
                      }
                    />
                    <Route path=":id" element={<ProductDetail />} />
                    <Route
                      path=":id/edit"
                      element={
                        <ProtectedRoute roles={PRODUCT_WRITE_ROLES}>
                          <ProductForm />
                        </ProtectedRoute>
                      }
                    />
                  </Route>

                  <Route path="orders">
                    <Route index element={<OrderList />} />
                    <Route path="new" element={<OrderForm />} />
                    <Route path=":id" element={<OrderDetail />} />
                    <Route path=":id/edit" element={<OrderForm />} />
                  </Route>

                  <Route
                    path="users"
                    element={
                      <ProtectedRoute roles={[ROLES.ADMIN]}>
                        <UserList />
                      </ProtectedRoute>
                    }
                  />

                  {/* Admin only in the router AND on the API. The audit trail holds
                      a copy of every field of every record, so it would otherwise
                      be a way around every other permission rule in the app. */}
                  <Route
                    path="audit"
                    element={
                      <ProtectedRoute roles={[ROLES.ADMIN]}>
                        <AuditLog />
                      </ProtectedRoute>
                    }
                  />
                </Route>

                {/* Anything else goes home. */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </AuthProvider>
        </ToastProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
