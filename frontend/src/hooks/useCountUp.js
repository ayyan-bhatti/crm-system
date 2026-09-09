import { useEffect, useRef, useState } from 'react';

/**
 * Animates a number counting up to its target whenever the target changes.
 *
 * Purely cosmetic — the real value is always what gets rendered the instant
 * this unmounts or the browser prefers reduced motion, so nothing here can
 * ever show a stale or wrong figure, only a slower-to-settle one.
 *
 * Non-numeric values (a formatted string like a date, or "—") pass straight
 * through unanimated — this only knows how to interpolate a plain number.
 */
export default function useCountUp(value, { duration = 600 } = {}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(0);
  const frameRef = useRef(null);

  useEffect(() => {
    const target = Number(value);
    let reduceMotion = false;
    try {
      reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
      // jsdom and some older browsers have no matchMedia at all — animate.
    }

    if (typeof value !== 'number' || !Number.isFinite(target) || reduceMotion) {
      setDisplay(value);
      return undefined;
    }

    const from = fromRef.current;
    const start = performance.now();

    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      // Ease-out cubic — fast start, settles rather than snapping.
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(Math.round(from + (target - from) * eased));

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the target should retrigger this
  }, [value]);

  return display;
}
