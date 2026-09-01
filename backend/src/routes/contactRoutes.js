const express = require('express');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ROLES } = require('../config/constants');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');
const {
  listContacts,
  getContact,
  updateConsent,
  updateTags,
  messageContact,
  exportContacts,
} = require('../controllers/contactController');

const router = express.Router();

router.use(protect);

/**
 * The marketing contacts API.
 *
 * EVERY ROLE REACHES THIS ROUTER, and the scoping is done per-record inside
 * `contactService` rather than by a role gate here. That is the opposite of
 * `/api/customers`, which refuses a sales rep at the router, and the
 * difference is deliberate: a rep has no customer book, but they do have the
 * contact details of the people whose orders they are fulfilling, and this
 * screen is how they message one. See `canViewContacts` in middleware/roles.js.
 *
 * ORDER MATTERS. `/export` is declared before `/:email`, or "export" would be
 * captured as an email address — the same trap `/orders/deliveries` sits in
 * front of, and the same fix.
 */

/**
 * The export is the one action gated at the router, because it is the one
 * whose risk is not the same as viewing. Admin only; see the reasoning on
 * `canExportContacts`.
 */
router.get('/export', requireRole(ROLES.ADMIN), exportContacts);

router.get('/', listContacts);

/*
 * The email address is the contact's identifier — a merged contact is not a
 * document and has no id of its own. Express decodes the path segment, so an
 * address with a `+` in it survives provided the client encodes it.
 */
router.get('/:email', getContact);
router.patch('/:email/consent', updateConsent);
router.put('/:email/tags', updateTags);

/**
 * Sending one message.
 *
 * Rate limited with the AI limiters, because the request may draft with the
 * model — and because a send endpoint without a limit is an open relay for
 * anyone whose staff session is stolen. The per-user limiter is the one that
 * matters here: a compromised account should not be able to message the whole
 * book one request at a time.
 */
router.post('/:email/message', aiSearchLimiter, aiPerUserLimiter, messageContact);

module.exports = router;
