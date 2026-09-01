const mongoose = require('mongoose');
const {
  REVIEW_REQUEST_DELAY_DAYS,
  REVIEW_REQUEST_DELAY_MIN,
  REVIEW_REQUEST_DELAY_MAX,
} = require('../config/marketing');

/**
 * How the post-sale automations behave. One document, ever.
 *
 * WHY A DOCUMENT RATHER THAN AN ENVIRONMENT VARIABLE
 *
 * The timing of a review request is an operational decision an administrator
 * should be able to change, and the RBAC table for this round says exactly
 * that: "Configure post-sale automation timing — admin". An environment
 * variable would put that behind a redeploy and a platform login, which makes
 * it a developer's decision wearing an administrator's label.
 *
 * The env-var defaults in config/marketing.js remain the STARTING values, so a
 * fresh deployment behaves sensibly before anybody opens the settings screen.
 *
 * WHY A SINGLETON RATHER THAN A GENERIC KEY/VALUE SETTINGS TABLE
 *
 * A generic settings collection is the tempting shape and it is worse here.
 * Values would be untyped strings validated at every read site, `enabled`
 * would be the string "false" (truthy) for somebody eventually, and there
 * would be no schema saying which keys exist. A named document with typed,
 * bounded, defaulted fields is self-documenting and the validation lives in
 * one place. If this app ever grows a second unrelated settings group, that is
 * a second small document, which is still better than one bag of strings.
 */
const automationSettingsSchema = new mongoose.Schema({
  /**
   * Always the literal 'automation'. Unique, so a second document cannot be
   * created — the singleton is enforced by the database rather than by every
   * caller remembering to use `findOne`.
   */
  key: {
    type: String,
    default: 'automation',
    unique: true,
    immutable: true,
  },

  /**
   * Whether the review-request job sends anything.
   *
   * A KILL SWITCH THAT DOES NOT LOSE DATA. Turned off, the job still runs and
   * still does nothing — it does not queue up a backlog to send when it is
   * turned back on, because `POST_SALE_WINDOW_DAYS` means anything older than
   * a month is out of scope by then. That is the behaviour you want from a
   * switch you flicked in a hurry: turning it back on resumes, it does not
   * flood.
   */
  reviewRequestEnabled: {
    type: Boolean,
    default: true,
  },

  /** Days after delivery. See the note in config/marketing.js on why five. */
  reviewRequestDelayDays: {
    type: Number,
    default: REVIEW_REQUEST_DELAY_DAYS,
    min: [REVIEW_REQUEST_DELAY_MIN, `The delay cannot be under ${REVIEW_REQUEST_DELAY_MIN} day`],
    max: [
      REVIEW_REQUEST_DELAY_MAX,
      `The delay cannot be over ${REVIEW_REQUEST_DELAY_MAX} days — past that, the ` +
        'purchase is no longer fresh enough to ask about',
    ],
  },

  reorderReminderEnabled: {
    type: Boolean,
    default: true,
  },

  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('AutomationSettings', automationSettingsSchema);
