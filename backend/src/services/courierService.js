const env = require('../config/env');
const { componentLogger } = require('../config/logger');
const { COURIER } = require('../config/constants');

const log = componentLogger('courier');

/**
 * Where a courier's own tracking page is, and — for the one courier that
 * offers it for free — the parcel's live status.
 *
 * WHY THIS IS TWO DIFFERENT LEVELS OF "REAL" INTEGRATION, AND WHY THAT SPLIT
 * IS DELIBERATE RATHER THAN UNFINISHED.
 *
 * TCS, Leopards and DHL are real Pakistani/international couriers, and it was
 * tempting to build one abstraction that "books a shipment" against all three
 * the way services/smsClient.js swaps between console and Twilio. That would
 * be dishonest here in a way it is not there: Twilio and Meta both hand a
 * working API key to anyone who signs up. TCS and Leopards do not — both
 * require a merchant/business account application before they issue ANY API
 * credential, and neither offers a public self-serve sandbox a solo developer
 * can reach today. There is no free "test key" for this app to wire up for
 * them, so pretending otherwise with a fake success response would be worse
 * than not having the feature.
 *
 * DHL is the exception: the DHL API Developer Portal (developer.dhl.com) hands
 * out a free sandbox key to anyone who signs up, for the Shipment Tracking -
 * Unified API. So DHL is the one courier this service can genuinely call.
 *
 * What every courier gets, with zero configuration and zero account anywhere:
 * a real link to THEIR OWN public tracking page. That needs no API key at all
 * — it is the same page a customer would reach by typing the courier's name
 * into a search engine — and it is honestly useful even without a live status
 * pulled into this app.
 *
 * If TCS or Leopards credentials are ever obtained (a real merchant account),
 * a `checkTcsStatus`/`checkLeopardsStatus` function belongs right here, next
 * to `checkDhlStatus` — this file is the seam, exactly like the console/real
 * split in mailer.js, smsClient.js and whatsappClient.js.
 */

const TRACKING_PAGES = {
  [COURIER.TCS]: 'https://www.tcsexpress.com/track/',
  [COURIER.LEOPARDS]: 'https://www.leopardscourier.com/leopards-tracking',
  /**
   * DHL's own tracking page DOES take the number as a query param, and the
   * format (`tracking-id`) is stable across every DHL country subdomain — so
   * unlike the two above, this one is safe to deep-link rather than just
   * pointing at the landing page.
   */
  [COURIER.DHL]: 'https://www.dhl.com/pk-en/home/tracking.html',
};

/**
 * A link to the courier's own tracking page for this parcel.
 *
 * Returns `null` for `other` or an unset courier — there is no page to link
 * to for a courier this app does not know, and a guessed URL that 404s is
 * worse than no link.
 *
 * NOT a deep link for TCS or Leopards, on purpose. Both sites' tracking pages
 * take the number through a form rather than a documented, stable query
 * parameter, and neither publishes one — guessing at `?cn=` or
 * `?tracking_number=` risks handing back a link that looks right and 404s or
 * lands on an empty results page. The honest version is: open the real page,
 * and show the number as plain text next to it for the customer to paste in.
 * DHL's page genuinely does take the number in the URL, so that one IS a deep
 * link.
 *
 * @returns {string|null}
 */
function buildTrackingUrl(courier, trackingNumber) {
  const page = TRACKING_PAGES[courier];
  if (!page || !trackingNumber) return page || null;

  if (courier === COURIER.DHL) {
    return `${page}?tracking-id=${encodeURIComponent(trackingNumber)}`;
  }

  return page;
}

const DHL_TRACKING_API = 'https://api-eu.dhl.com/track/shipments';
const REQUEST_TIMEOUT_MS = 8000;

/** Whether a live DHL lookup is actually possible right now. */
function isDhlLiveConfigured() {
  return Boolean(env.dhlTrackingApiKey);
}

/**
 * The parcel's live status from DHL's own Shipment Tracking - Unified API.
 *
 * Only ever called for `courier === 'dhl'` — see the note at the top of this
 * file for why TCS and Leopards have no equivalent. Never throws: a courier's
 * API being unreachable is a fact about the courier, not a fact about this
 * order, and the caller shows "live status unavailable" rather than an error
 * page over what is otherwise a perfectly normal order.
 *
 * @returns {Promise<{
 *   live: boolean,
 *   status?: string,
 *   description?: string,
 *   timestamp?: string,
 *   reason?: string,
 * }>}
 */
async function checkDhlStatus(trackingNumber) {
  if (!trackingNumber) {
    return { live: false, reason: 'no tracking number on this order' };
  }

  if (!isDhlLiveConfigured()) {
    return {
      live: false,
      reason:
        'DHL_TRACKING_API_KEY is not set. Free key: sign up at developer.dhl.com and ' +
        'subscribe to "Shipment Tracking - Unified".',
    };
  }

  try {
    const response = await fetch(
      `${DHL_TRACKING_API}?trackingNumber=${encodeURIComponent(trackingNumber)}`,
      {
        headers: { 'DHL-API-Key': env.dhlTrackingApiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      const detail = await response
        .text()
        .then((raw) => raw.trim().slice(0, 300))
        .catch(() => '');

      return {
        live: false,
        reason: `DHL responded ${response.status}${detail ? ` — ${detail}` : ''}`,
      };
    }

    const body = await response.json();
    /*
     * The Unified API returns one shipment per matching tracking number, with
     * its events newest-first. Sandbox keys answer against DHL's own demo
     * tracking numbers (documented on the DHL developer portal) rather than
     * arbitrary real ones — that is a property of the sandbox, not a bug here.
     */
    const shipment = body?.shipments?.[0];
    const latestEvent = shipment?.events?.[0];

    if (!shipment) {
      return { live: false, reason: 'DHL has no record of this tracking number' };
    }

    return {
      live: true,
      status: shipment.status?.statusCode || latestEvent?.statusCode || 'unknown',
      description: shipment.status?.description || latestEvent?.description || '',
      timestamp: shipment.status?.timestamp || latestEvent?.timestamp || null,
    };
  } catch (err) {
    log.error({ err }, 'DHL tracking lookup failed');
    return { live: false, reason: err.message };
  }
}

module.exports = { buildTrackingUrl, checkDhlStatus, isDhlLiveConfigured };
