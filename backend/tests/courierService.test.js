const env = require('../src/config/env');
const courierService = require('../src/services/courierService');

/**
 * Unit-level coverage of the live-status backends themselves — no HTTP
 * server, no database, just `courierService` with `fetch` stubbed the same
 * way tests/mailer.test.js stubs it for the webhook transport.
 *
 * THE CENTRAL CLAIM: EASYPOST IS TRIED FIRST, REGARDLESS OF COURIER.
 *
 * It is the one live backend with a genuine test mode — a magic tracking
 * code simulates a real status lifecycle through EasyPost's own API, the
 * shipping equivalent of a Stripe test card — so it is checked before DHL's
 * own API even when the order's courier is literally `dhl`.
 */
describe('courierService live status', () => {
  const realEasypostKey = env.easypostApiKey;
  const realDhlKey = env.dhlTrackingApiKey;
  const realFetch = global.fetch;

  afterEach(() => {
    env.easypostApiKey = realEasypostKey;
    env.dhlTrackingApiKey = realDhlKey;
    global.fetch = realFetch;
  });

  /** Captures the request instead of making one. */
  function stubFetch(response) {
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return response;
    };
    return calls;
  }

  describe('with nothing configured', () => {
    it('reports not-live for every courier, with a reason mentioning both keys', async () => {
      env.easypostApiKey = '';
      env.dhlTrackingApiKey = '';

      const result = await courierService.checkLiveStatus('other', 'ANY123');

      expect(result.live).toBe(false);
      expect(result.reason).toMatch(/EASYPOST_API_KEY/);
      expect(result.reason).toMatch(/DHL_TRACKING_API_KEY/);
    });

    it('reports not-live when there is no tracking number at all', async () => {
      env.easypostApiKey = 'EZTKtest';

      const result = await courierService.checkLiveStatus('dhl', '');

      expect(result).toEqual({ live: false, reason: 'no tracking number on this order' });
    });
  });

  describe('EasyPost, the test-mode backend', () => {
    beforeEach(() => {
      env.easypostApiKey = 'EZTKtest_1234567890';
    });

    it('sends HTTP Basic auth with the key as the username, no password', async () => {
      const calls = stubFetch({
        ok: true,
        json: async () => ({ status: 'delivered', mode: 'test', tracking_details: [] }),
      });

      await courierService.checkEasyPostStatus('EZ4000000004');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.easypost.com/v2/trackers');
      const expectedAuth = `Basic ${Buffer.from('EZTKtest_1234567890:').toString('base64')}`;
      expect(calls[0].options.headers.Authorization).toBe(expectedAuth);
      expect(JSON.parse(calls[0].options.body)).toEqual({
        tracker: { tracking_code: 'EZ4000000004' },
      });
    });

    it('reports a simulated delivery for the magic "delivered" test code, flagged as test mode', async () => {
      stubFetch({
        ok: true,
        json: async () => ({
          status: 'delivered',
          status_detail: 'arrived',
          mode: 'test',
          updated_at: '2026-08-30T10:00:00Z',
          tracking_details: [
            { message: 'Package delivered', datetime: '2026-08-30T10:00:00Z', status: 'delivered' },
          ],
        }),
      });

      const result = await courierService.checkEasyPostStatus('EZ4000000004');

      expect(result.live).toBe(true);
      expect(result.status).toBe('delivered');
      expect(result.description).toBe('Package delivered');
      expect(result.testMode).toBe(true);
    });

    it('does not mark a live (non-test) tracker as simulated', async () => {
      stubFetch({
        ok: true,
        json: async () => ({ status: 'in_transit', mode: 'production', tracking_details: [] }),
      });

      const result = await courierService.checkEasyPostStatus('1Z999AA10123456784');

      expect(result.live).toBe(true);
      expect(result.testMode).toBe(false);
    });

    it('reports failure with the response body rather than throwing on a non-2xx', async () => {
      stubFetch({ ok: false, status: 422, text: async () => 'tracking_code is invalid' });

      const result = await courierService.checkEasyPostStatus('bad-code');

      expect(result.live).toBe(false);
      expect(result.reason).toMatch(/422/);
      expect(result.reason).toMatch(/tracking_code is invalid/);
    });

    it('reports failure rather than throwing when the request cannot be made', async () => {
      global.fetch = async () => {
        throw new Error('connect ETIMEDOUT');
      };

      const result = await courierService.checkEasyPostStatus('EZ4000000004');

      expect(result).toEqual({ live: false, reason: 'connect ETIMEDOUT' });
    });

    it('is tried BEFORE DHL even when the order courier is dhl and a DHL key is also set', async () => {
      env.dhlTrackingApiKey = 'dhl-key-too';
      const calls = stubFetch({
        ok: true,
        json: async () => ({ status: 'in_transit', mode: 'test', tracking_details: [] }),
      });

      await courierService.checkLiveStatus('dhl', 'EZ2000000002');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.easypost.com/v2/trackers');
    });
  });

  describe('DHL, the fallback backend', () => {
    it('is used only when EasyPost is not configured', async () => {
      env.easypostApiKey = '';
      env.dhlTrackingApiKey = 'dhl-key';
      const calls = stubFetch({
        ok: true,
        json: async () => ({ shipments: [{ status: { statusCode: 'delivered', description: 'Delivered' } }] }),
      });

      const result = await courierService.checkLiveStatus('dhl', 'JD0141');

      expect(calls[0].url).toContain('api-eu.dhl.com');
      expect(calls[0].options.headers['DHL-API-Key']).toBe('dhl-key');
      expect(result).toEqual({ live: true, status: 'delivered', description: 'Delivered', timestamp: null });
    });

    it('is never called for a non-DHL courier, even with a key set', async () => {
      env.easypostApiKey = '';
      env.dhlTrackingApiKey = 'dhl-key';
      const calls = stubFetch({ ok: true, json: async () => ({ shipments: [] }) });

      const result = await courierService.checkLiveStatus('tcs', 'CN123');

      expect(calls).toHaveLength(0);
      expect(result.live).toBe(false);
    });

    it('says so plainly when DHL has no record of the number', async () => {
      env.easypostApiKey = '';
      env.dhlTrackingApiKey = 'dhl-key';
      stubFetch({ ok: true, json: async () => ({ shipments: [] }) });

      const result = await courierService.checkDhlStatus('unknown-number');

      expect(result).toEqual({ live: false, reason: 'DHL has no record of this tracking number' });
    });
  });
});
