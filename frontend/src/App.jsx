import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { BuyerAuthProvider } from './context/BuyerAuthContext';
import { CartProvider } from './context/CartContext';
import ProtectedRoute from './components/ProtectedRoute';
import DashboardLayout from './components/DashboardLayout';
import ShopLayout from './components/ShopLayout';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { Spinner } from './components/common';

import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import AcceptInvite from './pages/AcceptInvite';

import {
  CUSTOMER_VIEW_ROLES,
  ORDER_WRITE_ROLES,
  PRODUCT_WRITE_ROLES,
  ROLES,
} from './constants';

/**
 * Route table.
 *
 * THE APP'S PRIMARY IDENTITY IS THE STOREFRONT, NOT THE CRM.
 *
 * Everything at the root — "/", "/products", "/login", "/checkout" and so on
 * — is the public shop: what a visitor sees the moment they open the link,
 * signed in or not. The internal CRM is deliberately the SECONDARY thing,
 * tucked under "/crm" and reached from a small link in the shop header
 * rather than owning the root. That is the inverse of how this app started
 * (the CRM used to own "/"), and the swap is the point: this is now an
 * e-commerce storefront with a CRM on the side, not a CRM with a storefront
 * bolted on.
 *
 * Two public CRM auth routes; everything else CRM-side sits inside
 * <ProtectedRoute>, which also renders the shared dashboard shell. Where a
 * route is limited to certain roles (product editing, user management) the
 * `roles` prop redirects anyone else to "/crm" — the API enforces the same
 * rules, so this is about not showing people screens they cannot use.
 *
 * CODE SPLITTING: the authenticated pages are lazy-loaded, the two CRM auth
 * pages are not. The charting library alone is most of the app's JavaScript,
 * and bundling it with the login screen means every visitor downloads it
 * before they can type a password. Splitting at the route boundary lets each
 * page arrive when it is actually needed.
 *
 * Note "/crm/customers/new" is declared before "/crm/customers/:id",
 * otherwise "new" would be captured as an id.
 */

const Dashboard = lazy(() => import('./pages/Dashboard'));

const CustomerList = lazy(() => import('./pages/customers/CustomerList'));
const CustomerDetail = lazy(() => import('./pages/customers/CustomerDetail'));
const CustomerForm = lazy(() => import('./pages/customers/CustomerForm'));

const ProductList = lazy(() => import('./pages/products/ProductList'));
const ProductDetail = lazy(() => import('./pages/products/ProductDetail'));
const ProductForm = lazy(() => import('./pages/products/ProductForm'));

const OrderList = lazy(() => import('./pages/orders/OrderList'));
const DeliveryBoard = lazy(() => import('./pages/orders/DeliveryBoard'));
const OrderDetail = lazy(() => import('./pages/orders/OrderDetail'));
const OrderForm = lazy(() => import('./pages/orders/OrderForm'));

const UserList = lazy(() => import('./pages/users/UserList'));
const AuditLog = lazy(() => import('./pages/AuditLog'));
const Approvals = lazy(() => import('./pages/Approvals'));
const Account = lazy(() => import('./pages/Account'));

const ShopHome = lazy(() => import('./pages/shop/Home'));
const ShopProductGrid = lazy(() => import('./pages/shop/ProductGrid'));
const ShopProductDetail = lazy(() => import('./pages/shop/ProductDetail'));
const BuyerLogin = lazy(() => import('./pages/shop/BuyerLogin'));
const BuyerRegister = lazy(() => import('./pages/shop/BuyerRegister'));
const Checkout = lazy(() => import('./pages/shop/Checkout'));
const OrderConfirmation = lazy(() => import('./pages/shop/OrderConfirmation'));
const BuyerOrders = lazy(() => import('./pages/shop/BuyerOrders'));
const BuyerOrderDetail = lazy(() => import('./pages/shop/BuyerOrderDetail'));
const BuyerAccount = lazy(() => import('./pages/shop/BuyerAccount'));

/**
 * Mounts the buyer session and cart contexts around the whole `/shop` tree,
 * and nothing else. The internal CRM never needs a buyer session or a cart,
 * so those two providers stay scoped to the one route subtree that does —
 * same reasoning as `AuthProvider` staying outside it, just in the other
 * direction.
 */
function ShopRoot() {
  return (
    <BuyerAuthProvider>
      <CartProvider>
        <Outlet />
      </CartProvider>
    </BuyerAuthProvider>
  );
}

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
                {/*
                  --- Storefront (the app's front door) ----------------------
                  Public, and deliberately outside <ProtectedRoute>: a shopper
                  browses without an account, and the buyer session this tree
                  carries is a wholly separate credential from the staff
                  session used below — signing in as a buyer here has no
                  effect on, and is never checked against, the CRM session.
                */}
                <Route element={<ShopRoot />}>
                  <Route element={<ShopLayout />}>
                    <Route index element={<ShopHome />} />
                    <Route path="products" element={<ShopProductGrid />} />
                    <Route path="products/:id" element={<ShopProductDetail />} />
                    <Route path="login" element={<BuyerLogin />} />
                    <Route path="register" element={<BuyerRegister />} />
                    {/* Buyer sign-in required — see the note at the top of
                        Checkout.jsx for why guest checkout was removed. */}
                    <Route path="checkout" element={<Checkout />} />
                    {/*
                      TWO ROUTES TO ONE PAGE, and both are needed.

                      `/order-confirmation/:id` is the cash-on-delivery path,
                      where an order already exists to link to.

                      `/order-confirmation` with no id is where STRIPE sends the
                      buyer back — it appends `?session_id=cs_…`, and at that
                      moment there may well be no order to name yet, because the
                      webhook that creates it can still be in flight. Requiring
                      an id in the path would mean inventing one before the
                      order exists, which is exactly the shortcut that ends with
                      orders created by a redirect instead of by a confirmed
                      payment.
                    */}
                    <Route path="order-confirmation" element={<OrderConfirmation />} />
                    <Route path="order-confirmation/:id" element={<OrderConfirmation />} />
                    <Route path="account/orders" element={<BuyerOrders />} />
                    <Route path="account/orders/:id" element={<BuyerOrderDetail />} />
                    <Route path="account/addresses" element={<BuyerAccount />} />
                  </Route>
                </Route>

                {/*
                  --- CRM (staff, reached via the "CRM" link in the shop
                  header) --------------------------------------------------
                */}
                <Route path="crm">
                  <Route path="login" element={<Login />} />
                  <Route path="register" element={<Register />} />
                  {/* Not lazy-loaded: someone locked out of their account is
                      the last person who should wait for a chunk to download. */}
                  <Route path="forgot-password" element={<ForgotPassword />} />
                  <Route path="reset-password" element={<ResetPassword />} />
                  {/* Public: the invitee has no account to authenticate with
                      until they have been through this page. */}
                  <Route path="accept-invite" element={<AcceptInvite />} />

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

                    {/*
                      The whole customer section is behind a guard, not just its
                      write screens. A sales rep typing /crm/customers into the
                      address bar has to land somewhere sensible rather than on a
                      page that renders and then fills with 403s.

                      The write screens are NOT separately gated: a manager reaches
                      them and submitting queues a change request for an admin to
                      approve. Hiding them would turn "needs approval" into "not
                      allowed", which is a different rule.
                    */}
                    <Route
                      path="customers"
                      element={
                        <ProtectedRoute roles={CUSTOMER_VIEW_ROLES}>
                          <Outlet />
                        </ProtectedRoute>
                      }
                    >
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

                    <Route path="deliveries" element={<DeliveryBoard />} />
                    <Route path="orders">
                      <Route index element={<OrderList />} />
                      {/*
                        A rep fulfils orders rather than agreeing them, and has no
                        customer book to choose a customer from — the form could
                        not be completed even if the route allowed it.
                      */}
                      <Route
                        path="new"
                        element={
                          <ProtectedRoute roles={ORDER_WRITE_ROLES}>
                            <OrderForm />
                          </ProtectedRoute>
                        }
                      />
                      <Route path=":id" element={<OrderDetail />} />
                      <Route
                        path=":id/edit"
                        element={
                          <ProtectedRoute roles={ORDER_WRITE_ROLES}>
                            <OrderForm />
                          </ProtectedRoute>
                        }
                      />
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

                    {/* Opened to managers alongside admins for buyer-initiated
                        requests — see the backend's phase 4 note on
                        /api/change-requests. A manager's response is filtered
                        server-side to those, so the route guard only has to
                        stop matching the API's own rule rather than add one. */}
                    <Route
                      path="approvals"
                      element={
                        <ProtectedRoute roles={[ROLES.ADMIN, ROLES.MANAGER]}>
                          <Approvals />
                        </ProtectedRoute>
                      }
                    />
                  </Route>
                </Route>

                {/* Anything else goes to the shop home, the app's front door. */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </AuthProvider>
        </ToastProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
