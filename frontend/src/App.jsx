import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import DashboardLayout from './components/DashboardLayout';
import { Spinner } from './components/common';

import Login from './pages/Login';
import Register from './pages/Register';

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

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* One boundary around the routes: a lazy page resolves in milliseconds
            on a warm connection, so a full-page spinner is all this needs. */}
        <Suspense fallback={<Spinner full />}>
          <Routes>
            {/* --- Public ----------------------------------------------- */}
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />

            {/* --- Authenticated ---------------------------------------- */}
            <Route
              element={
                <ProtectedRoute>
                  <DashboardLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Dashboard />} />

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
    </BrowserRouter>
  );
}
