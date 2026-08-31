import { describe, expect, it } from 'vitest';
import { deliveryUrgency } from './ui';

/**
 * The delivery alarm.
 *
 * A date sitting in grey text is not a warning, and this is the helper that
 * turns "estimated delivery 2 September" into "arriving tomorrow" — the point
 * at which a courier hand-off can still be arranged in time, and therefore the
 * last moment the information is worth anything.
 *
 * `now` is injected rather than mocked so these read as a table of facts
 * instead of a sequence of clock manipulations.
 */

const NOW = new Date('2026-09-01T12:00:00Z');

/** An order due `days` from NOW, still in flight. */
const order = (days, extra = {}) => {
  const due = new Date(NOW);
  due.setDate(due.getDate() + days);
  return { fulfilment: 'shipped', estimatedDeliveryAt: due.toISOString(), ...extra };
};

describe('deliveryUrgency', () => {
  it('says nothing about an order with no estimate', () => {
    expect(deliveryUrgency({ fulfilment: 'processing' }, NOW).level).toBe('none');
  });

  it('is quiet while the date is comfortably ahead', () => {
    expect(deliveryUrgency(order(9), NOW).level).toBe('ontrack');
  });

  it('notices two or three days out without shouting', () => {
    expect(deliveryUrgency(order(2), NOW).level).toBe('soon');
    expect(deliveryUrgency(order(3), NOW).level).toBe('soon');
  });

  /** THE ALARM. One day left is the whole reason this helper exists. */
  it('raises the alarm one day out', () => {
    const urgency = deliveryUrgency(order(1), NOW);
    expect(urgency.level).toBe('tomorrow');
    expect(urgency.label).toBe('Arriving tomorrow');
  });

  it('treats the due day itself as just as urgent', () => {
    expect(deliveryUrgency(order(0), NOW).level).toBe('tomorrow');
    expect(deliveryUrgency(order(0), NOW).label).toBe('Due today');
  });

  it('escalates once the promised date has passed', () => {
    expect(deliveryUrgency(order(-1), NOW).label).toBe('Overdue by 1 day');
    expect(deliveryUrgency(order(-4), NOW).level).toBe('overdue');
    expect(deliveryUrgency(order(-4), NOW).label).toBe('Overdue by 4 days');
  });

  /**
   * THE RULE THAT KEEPS THE ALARM MEANINGFUL.
   *
   * An order that arrived last week is not overdue, however long ago its
   * estimate was. Painting settled orders red is the fastest way to teach staff
   * that the red ones can be ignored — which is precisely what makes a genuine
   * one invisible.
   */
  it('stays silent on delivered and cancelled orders whatever the date says', () => {
    expect(deliveryUrgency(order(-30, { fulfilment: 'delivered' }), NOW).level).toBe('none');
    expect(deliveryUrgency(order(-30, { fulfilment: 'cancelled' }), NOW).level).toBe('none');
    // `deliveredAt` alone is enough, even if the status has not caught up.
    expect(
      deliveryUrgency(order(-30, { deliveredAt: NOW.toISOString() }), NOW).level
    ).toBe('none');
  });

  /**
   * "Tomorrow" is a calendar day, not a 24-hour window. An order due tomorrow
   * at 09:00 is due tomorrow whether it is now 08:00 or 23:00 — an elapsed-time
   * comparison would call one of those "today" and quietly move the alarm a day.
   */
  it('compares calendar days rather than elapsed hours', () => {
    /*
     * Built in LOCAL time on purpose. An earlier version of this test wrote
     * both instants as UTC and failed in UTC+5, where 23:30Z on the 1st is
     * already 04:30 on the 2nd — so the two timestamps landed on the same local
     * day and the helper correctly said "Due today" while the test insisted on
     * "Arriving tomorrow". The helper is right: a delivery date shown to a
     * person is a date in THEIR calendar, so the test has to speak the same
     * calendar rather than assert a UTC coincidence.
     */
    const lateEvening = new Date(2026, 8, 1, 23, 30);
    const dueTomorrowMorning = {
      fulfilment: 'shipped',
      estimatedDeliveryAt: new Date(2026, 8, 2, 8, 0).toISOString(),
    };

    expect(deliveryUrgency(dueTomorrowMorning, lateEvening).label).toBe('Arriving tomorrow');

    // Eight hours EARLIER on the same local day must give the same answer —
    // which an elapsed-milliseconds comparison would not.
    const sameDayMorning = new Date(2026, 8, 1, 8, 0);
    expect(deliveryUrgency(dueTomorrowMorning, sameDayMorning).label).toBe('Arriving tomorrow');
  });
});
