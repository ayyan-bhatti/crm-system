const express = require('express');
const { protect } = require('../middleware/auth');
const { requireManagerOrAdmin } = require('../middleware/roles');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');
const {
  listCampaigns,
  getCampaign,
  previewAudience,
  draftContent,
  createCampaign,
  updateCampaign,
  sendCampaign,
  deleteCampaign,
} = require('../controllers/campaignController');

const router = express.Router();

/**
 * Campaigns — admin and manager only, for the whole router.
 *
 * A sales rep cannot launch a bulk send. The reasoning matches `writeOrders`:
 * a campaign is a commitment made in the business's name to many people at
 * once, and a rep's remit is the work in front of them. What a rep DOES get is
 * `POST /api/contacts/:email/message` — one person, one message, their own
 * contact — which is the marketing action their job actually calls for.
 *
 * Gated at the router rather than per-handler so that adding a route here
 * cannot accidentally be the one that forgets.
 */
router.use(protect, requireManagerOrAdmin);

/*
 * Declared before `/:id`, or "preview" and "draft" would be read as campaign
 * ids and 404 confusingly.
 */
router.post('/preview', previewAudience);

/** Drafting calls the model, so it carries the AI limiters. */
router.post('/draft', aiSearchLimiter, aiPerUserLimiter, draftContent);

router.route('/').get(listCampaigns).post(createCampaign);

router.route('/:id').get(getCampaign).patch(updateCampaign).delete(deleteCampaign);

/**
 * Sending, or queueing for approval — the controller's response says which.
 *
 * A POST to a sub-resource rather than a PATCH setting `status: 'sent'`. The
 * two are not the same shape: this is not a field being written, it is an act
 * with consequences outside the database, and modelling it as a status change
 * would invite a client to "correct" the status back.
 */
router.post('/:id/send', sendCampaign);

module.exports = router;
