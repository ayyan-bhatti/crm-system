import { useId } from 'react';

/**
 * How many of a thing to buy.
 *
 * WHY THIS REPLACED A `<select>` OF 1 TO 10.
 *
 * The old control was hard-coded to ten options, which managed to be wrong in
 * both directions at the same time. It offered 10 of a product we had 3 of — so
 * the shopper chose a number, pressed the button, and got an error about stock
 * they had no way of knowing about. And it refused to sell 12 reams of paper we
 * had 200 of, silently capping the order at a number nobody had decided on and
 * giving no hint that a limit was even involved.
 *
 * The ceiling now comes from the server (`maxOrderQty`), which knows the real
 * stock and the real per-order cap, so the control can only ever offer numbers
 * that will actually go through.
 *
 * A STEPPER RATHER THAN A DROPDOWN, because the overwhelmingly common change is
 * ±1 and a dropdown makes that two interactions and a scroll. The text input is
 * kept alongside the buttons so somebody buying 17 does not have to press "+"
 * sixteen times — a stepper without a typable field has the dropdown's problem
 * in reverse.
 *
 * The limit is stated in words underneath rather than only enforced. A "+"
 * button that stops responding is indistinguishable from a broken one.
 */
export default function QuantityStepper({ value, onChange, max, disabled = false }) {
  const id = useId();
  const ceiling = Math.max(1, max || 1);
  const atMax = value >= ceiling;
  const atMin = value <= 1;

  const clamp = (next) => Math.min(Math.max(1, next), ceiling);

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        Quantity
      </label>

      <div className="inline-flex items-stretch overflow-hidden rounded-lg border border-hairline bg-raised">
        <button
          type="button"
          aria-label="Decrease quantity"
          disabled={disabled || atMin}
          onClick={() => onChange(clamp(value - 1))}
          className="px-3 text-lg leading-none text-ink-2 transition-colors hover:bg-neutral-wash disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
        >
          −
        </button>

        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={ceiling}
          value={value}
          disabled={disabled}
          /*
           * Committed on blur, not on every keystroke. Clamping as the shopper
           * types turns a half-finished "12" into "1" the instant the first
           * character lands, which is maddening and looks like a bug.
           */
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          onBlur={(e) => onChange(clamp(Number(e.target.value) || 1))}
          className="w-14 border-x border-hairline bg-transparent py-2 text-center text-sm font-medium text-ink [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />

        <button
          type="button"
          aria-label="Increase quantity"
          disabled={disabled || atMax}
          onClick={() => onChange(clamp(value + 1))}
          className="px-3 text-lg leading-none text-ink-2 transition-colors hover:bg-neutral-wash disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
        >
          +
        </button>
      </div>

      {/* Why "+" stopped working, said out loud rather than left to be guessed. */}
      <p className="mt-1.5 text-xs text-muted">
        {atMax
          ? ceiling === 1
            ? 'Only one of these left.'
            : `${ceiling} is the most you can order of this.`
          : `Up to ${ceiling} per order.`}
      </p>
    </div>
  );
}
