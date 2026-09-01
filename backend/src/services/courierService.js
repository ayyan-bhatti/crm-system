const env = require('../config/env');
const { componentLogger } = require('../config/logger');
const { COURIER } = require('../config/constants');

const log = componentLogger('courier');

/**
 * Where a courier's own tracking page is, and the parcel's LIVE status where
 * that is genuinely obtainable.
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
 * them directly, so pretending otherwise with a fake success response would
 * be worse than not having the feature.
 *
 * What every courier gets, with zero configuration and zero account anywhere:
 * a real link to THEIR OWN public tracking page. That needs no API key at all
 * — it is the same page a customer would reach by typing the courier's name
 * into a search engine — and it is honestly useful even without a live status
 * pulled into this app.
 *
 * LIVE STATUS: EASYPOST FIRST, DHL AS A FALLBACK
 *
 * Two different live backends exist here, and they earn their place for two
 * different reasons.
 *
 * EasyPost is the one worth reaching for first, because it is the closest
 * thing shipping has to Stripe's test mode — the reason it is here at all. A
 * free signup hands over a TEST key immediately (no business verification),
 * and a small published set of "magic" tracking codes each simulate a full,
 * real status lifecycle through EasyPost's own API — not a canned demo
 * response, an actual tracker object that genuinely reports `pre_transit`,
 * `in_transit`, `out_for_delivery`, `delivered` and so on:
 *
 *   EZ1000000001  pre_transit       EZ5000000005  return_to_sender
 *   EZ2000000002  in_transit        EZ6000000006  failure
 *   EZ3000000003  out_for_delivery  EZ7000000007  unknown
 *   EZ4000000004  delivered
 *
 * Type one of those into the tracking-number field on ANY courier and, with
 * `EASYPOST_API_KEY` set, "Check live status" pulls a real answer for it —
 * exactly the "test mode, like we did with Stripe" experience. A production
 * EasyPost key can also track real shipments across the many carriers EasyPost
 * itself supports, carrier auto-detected from the tracking code's shape.
 *
 * DHL's own Shipment Tracking - Unified API is kept as a second, DHL-specific
 * path for when only `DHL_TRACKING_API_KEY` is set and EasyPost is not — its
 * sandbox only answers against DHL's own published demo numbers rather than
 * simulating a lifecycle, which is a real but smaller thing than EasyPost's
 * test mode.
 *
 * If TCS or Leopards credentials are ever obtained (a real merchant account),
 * a `checkTcsStatus`/`checkLeopardsStatus` function belongs right here, next
 * to the two below — this file is the seam, exactly like the console/real
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

const EASYPOST_API = 'https://api.easypost.com/v2/trackers';

/** Whether a live EasyPost lookup is actually possible right now. */
function isEasyPostLiveConfigured() {
  return Boolean(env.easypostApiKey);
}

/**
 * The parcel's live status from EasyPost's Tracker API.
 *
 * Works for any courier, including the seven magic test tracking codes listed
 * in the file header — those are recognised and simulated by EasyPost itself
 * regardless of what this app's own `courier` field says, so a demo order can
 * use courier `other` with tracking number `EZ4000000004` and still get back
 * a genuine `delivered` tracker.
 *
 * No `carrier` hint is sent on the create call. EasyPost auto-detects it from
 * the tracking code's own shape, which is safer than this app guessing at
 * EasyPost's internal carrier identifier strings and getting one wrong.
 *
 * Never throws — see the note on `checkDhlStatus`.
 *
 * @returns {Promise<{ live: boolean, status?: string, description?: string, timestamp?: string, testMode?: boolean, reason?: string }>}
 */
async function checkEasyPostStatus(trackingNumber) {
  if (!trackingNumber) {
    return { live: false, reason: 'no tracking number on this order' };
  }

  if (!isEasyPostLiveConfigured()) {
    return {
      live: false,
      reason:
        'EASYPOST_API_KEY is not set. Free key with a genuine test mode: sign up at ' +
        'easypost.com and copy the Test API key from the API Keys page. Try tracking ' +
        'number EZ4000000004 once it is set — EasyPost simulates a real "delivered" ' +
        'tracker for it, no real shipment needed.',
    };
  }

  try {
    /*
     * HTTP Basic auth with the API key as the username and no password —
     * EasyPost's own convention, matching the `-u "API_KEY":` shown in their
     * docs.
     */
    const credentials = Buffer.from(`${env.easypostApiKey}:`).toString('base64');

    const response = await fetch(EASYPOST_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ tracker: { tracking_code: trackingNumber } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response
        .text()
        .then((raw) => raw.trim().slice(0, 300))
        .catch(() => '');

      return {
        live: false,
        reason: `EasyPost responded ${response.status}${detail ? ` — ${detail}` : ''}`,
      };
    }

    const tracker = await response.json();
    const latestDetail = tracker.tracking_details?.[tracker.tracking_details.length - 1];

    return {
      live: true,
      status: tracker.status || 'unknown',
      description: latestDetail?.message || tracker.status_detail || tracker.status || '',
      timestamp: latestDetail?.datetime || tracker.updated_at || null,
      // Surfaced so the UI can label a simulated result as such, the same way
      // Stripe's own dashboard marks a test-mode payment.
      testMode: tracker.mode === 'test',
    };
  } catch (err) {
    log.error({ err }, 'EasyPost tracking lookup failed');
    return { live: false, reason: err.message };
  }
}

/**
 * The single entry point the controller calls: whichever live backend is
 * actually configured, for whichever courier the order has.
 *
 * EASYPOST FIRST, regardless of `courier` — it is carrier-agnostic and is
 * the one with a genuine test mode. DHL's own API is the fallback for a
 * deployment that only set up `DHL_TRACKING_API_KEY`. Neither configured, or
 * neither able to resolve this tracking number, comes back as `live: false`
 * with a `reason` a human can act on — never an error thrown at the caller.
 */
async function checkLiveStatus(courier, trackingNumber) {
  if (isEasyPostLiveConfigured()) {
    return checkEasyPostStatus(trackingNumber);
  }

  if (courier === COURIER.DHL && isDhlLiveConfigured()) {
    return checkDhlStatus(trackingNumber);
  }

  if (!trackingNumber) {
    return { live: false, reason: 'no tracking number on this order' };
  }

  return {
    live: false,
    reason:
      'No live tracking backend is configured. Set EASYPOST_API_KEY for a free test-mode ' +
      'lookup that works for any courier, or DHL_TRACKING_API_KEY for DHL specifically — ' +
      'see backend/.env.example.',
  };
}

module.exports = {
  buildTrackingUrl,
  checkDhlStatus,
  isDhlLiveConfigured,
  checkEasyPostStatus,
  isEasyPostLiveConfigured,
  checkLiveStatus,
};
