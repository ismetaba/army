"use client";

import type { ReactNode } from "react";
import { SectionHead } from "@/components/ledger/chrome";

/*
 * The settings screen's field vocabulary (handoff § 05, § Geometry).
 *
 * Fields are UNDERLINES, not boxes: `.field` in globals.css carries the geometry (full width,
 * no border except a 1px bottom rule, 8px bottom padding, no outline). What it cannot carry is
 * WHICH colour that rule should be, because the screen has four answers — empty/optional is
 * `rule`, filled is ink, a row set to `claude-cli` or carrying an error is danger, and focus is
 * always accent.
 *
 * `.field`'s own `:not(:placeholder-shown)` / `:focus` rules are unlayered CSS, and unlayered CSS
 * beats every Tailwind utility (they live in `@layer utilities`). So the state colours below are
 * written with Tailwind's `!` modifier, which is the only thing that outranks them — and the
 * focus colour is `!` too, at one more specificity step (`:focus`), so the accent underline still
 * wins over the danger one. That ordering is deliberate: the focus signal must never be the thing
 * that loses (handoff § Accessibility, "never remove outlines without replacing them").
 */

export type UnderlineState = "empty" | "filled" | "danger";

/**
 * Glass fields are PLATES (`.field` in globals.css carries the geometry: plate fill, 1px soft
 * border, radius 12). The per-state border/tint written out in full so Tailwind's scanner sees
 * every class it has to generate. The names keep their historical "Underline" spelling — every
 * call site would otherwise churn for a rename with no behaviour in it.
 */
const UNDERLINE: Record<UnderlineState, string> = {
  empty: "",
  filled: "",
  danger: "border-danger-line! bg-danger-tint!",
};

/**
 * `.field` also fixes `color`, so the ink of a field is the same fight as its border and needs
 * the same `!`. Without it every value renders in ink and the danger state is border-only —
 * which is exactly the colour-alone signalling the handoff forbids.
 */
const INK: Record<UnderlineState, string> = {
  empty: "text-muted!",
  filled: "text-fg!",
  danger: "text-danger-ink!",
};

/** The gold border IS the focus signal for a field (the ring comes from `.field:focus`). */
const FOCUS = "focus:border-accent-line!";

function stateOf(value: string, danger: boolean): UnderlineState {
  if (danger) return "danger";
  return value.trim() === "" ? "empty" : "filled";
}

const SCALE = {
  /** Defaults — the two fields the whole config hangs off. */
  lg: "text-[12px]",
  /** Everything else. */
  sm: "text-[11px]",
} as const;

export type FieldScale = keyof typeof SCALE;

/**
 * The keyboard focus ring for an action.
 *
 * Handoff § Accessibility: "give every interactive element a visible focus ring or underline …
 * never remove outlines without replacing them". Fields get the accent underline; a button has
 * nothing to underline, so it gets a 2px accent ring at 2px offset.
 *
 * Written as the `outline` SHORTHAND in one arbitrary property rather than as `outline-2
 * outline-solid outline-accent`, so style, width and colour arrive together and `outline-color`
 * never has to win a cascade fight against its own initial value (`currentColor`, i.e. the
 * button's text — which on the ink-filled SAVE button is paper, and a paper ring on paper is not
 * a focus signal). The foundation's buttons carry `transition-colors`, which in Tailwind v4
 * includes `outline-color`, so the ring fades in with the rest of the hover/focus colours.
 */
const FOCUS_RING =
  "focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]";

/**
 * What every button on this screen adds to the foundation's `PrimaryButton` / `OutlineButton` /
 * `QuietButton`: the focus ring above, and a ≥44px target on the 375 layout (handoff
 * § Accessibility, "Targets"). Above `sm` the height constraint is dropped so the buttons keep
 * the ~32px the design draws them at.
 */
export const ACTION = `inline-flex items-center justify-center min-h-11 sm:min-h-0 ${FOCUS_RING}`;

/** The same, for a button that is only a word and has no box (`RELOAD FROM DISK`). */
export const QUIET_ACTION = `inline-flex items-center min-h-11 sm:min-h-0 ${FOCUS_RING}`;

/** A single-line underline field. Machine text, so mono by default. */
export function UnderlineInput({
  id,
  value,
  onChange,
  placeholder,
  danger = false,
  invalid = false,
  scale = "sm",
  describedBy,
  ariaLabel,
  inputMode,
  autoComplete,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * Required, not optional: `.field`'s "filled" rule keys off `:placeholder-shown`, so an input
   * with no placeholder attribute has no empty state at all. Every field on this screen has
   * something useful to suggest anyway.
   */
  placeholder: string;
  danger?: boolean;
  invalid?: boolean;
  scale?: FieldScale;
  describedBy?: string;
  ariaLabel?: string;
  inputMode?: "numeric";
  autoComplete?: string;
}) {
  const state = stateOf(value, danger || invalid);
  return (
    <input
      id={id}
      type="text"
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      autoComplete={autoComplete}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      className={`field mono ${SCALE[scale]} placeholder:text-muted ${INK[state]} ${UNDERLINE[state]} ${FOCUS}`}
    />
  );
}

/** An underline field for a whole-number value that keeps whatever was typed (see ConfigForm). */
export function UnderlineNumber(props: Omit<Parameters<typeof UnderlineInput>[0], "inputMode">) {
  return <UnderlineInput {...props} inputMode="numeric" />;
}

/**
 * A select drawn as an underline with its own caret. `appearance-none` removes the platform
 * control (which is a box with a radius, and this design has neither); the `▼` is a
 * `pointer-events-none` overlay so the whole width still opens the menu.
 */
export function UnderlineSelect({
  id,
  value,
  onChange,
  options,
  inheritLabel,
  danger = false,
  invalid = false,
  scale = "sm",
  ariaLabel,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  /** The `""` option, when this select is allowed to mean "no override". */
  inheritLabel?: string;
  danger?: boolean;
  invalid?: boolean;
  scale?: FieldScale;
  ariaLabel?: string;
  describedBy?: string;
}) {
  const state = stateOf(value, danger || invalid);
  return (
    <div className="relative flex w-full min-w-0 items-center">
      <select
        id={id}
        value={value}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={`field mono appearance-none pr-5 ${SCALE[scale]} ${INK[state]} ${UNDERLINE[state]} ${FOCUS}`}
      >
        {inheritLabel === undefined ? null : <option value="">{inheritLabel}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className={`pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-[8px] leading-none ${
          state === "danger" ? "text-danger" : "text-ink-3"
        }`}
      >
        ▼
      </span>
    </div>
  );
}

/** An underlined multi-line field (the design uses one for feedback in 04c). */
export function UnderlineTextarea({
  id,
  value,
  onChange,
  placeholder,
  rows = 3,
  invalid = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
  invalid?: boolean;
}) {
  const state = stateOf(value, invalid);
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.target.value)}
      className={`field mono resize-y text-[11px] leading-[1.9] placeholder:text-muted ${INK[state]} ${UNDERLINE[state]} ${FOCUS}`}
    />
  );
}

/** Label (small caps mono) above a field, with the field's error underneath it. */
export function SettingsField({
  label,
  note,
  htmlFor,
  error,
  hideLabel = false,
  children,
}: {
  label: string;
  /** A short mono aside beside the label — "name only, never the value". */
  note?: string;
  htmlFor: string;
  error?: string;
  /** For a field whose sub-head already names it: the label stays, for screen readers only. */
  hideLabel?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col ${hideLabel ? "gap-0" : "gap-2.5"}`}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <label htmlFor={htmlFor} className={hideLabel ? "sr-only" : "label"}>
          {label}
        </label>
        {note === undefined ? null : (
          <span className="mono text-[9px] text-muted">{note}</span>
        )}
      </div>
      {children}
      {error === undefined ? null : <FieldError htmlFor={htmlFor}>{error}</FieldError>}
    </div>
  );
}

/**
 * One field's problem, under that field. Carries the hatched danger square as well as the colour,
 * so the message is not red-only (handoff § Accessibility).
 */
export function FieldError({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <p
      className="flex items-start gap-2 text-[11px] leading-[1.5] text-danger"
      data-field-error={htmlFor}
    >
      <span className="mark mark-error mt-[4px]" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The inline danger callout: a coral-tinted pane with a coral border and the solid coral disc. */
export function DangerCallout({
  children,
  testId,
  role = "note",
}: {
  children: ReactNode;
  testId?: string;
  role?: "note" | "alert";
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      className="flex min-w-0 items-start gap-2.5 rounded-[14px] border border-danger-line bg-danger-tint px-4 py-3"
    >
      <span className="mark mark-error mt-[5px]" aria-hidden />
      <div className="min-w-0 text-[12px] leading-[1.55] text-danger-deep">{children}</div>
    </div>
  );
}

/**
 * One of the four section PANES (Glass § 05: radius 20, 24/26px padding, a title with a
 * right-aligned mono hint). `raised` marks the first section, which sits on `pane-header` with
 * the shadow; the rest are quiet panes. The id is the anchor the section nav jumps to.
 */
export function SettingsSection({
  id,
  title,
  aside,
  raised = false,
  children,
}: {
  id: string;
  title: string;
  aside: string;
  raised?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className={`flex min-w-0 scroll-mt-6 flex-col gap-5 px-6 py-6 ${raised ? "pane-head" : "pane-quiet rounded-[20px]!"}`}
      data-settings-section={id}
    >
      <SectionHead
        title={title}
        aside={<span className="mono hidden text-[9.5px] text-muted sm:block">{aside}</span>}
      />
      {children}
    </section>
  );
}

/**
 * A sub-block inside a section: a dotted rule, then a mono small-caps heading. Used for the parts
 * of the real config the four designed sections do not name (viewports, off-limits, the registry
 * list, registration) — they keep their section's 2px rule rather than inventing a fifth one.
 */
export function SubHead({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-dotted border-line pt-5">
      <span className="label">{children}</span>
      {aside === undefined ? null : (
        <span className="mono text-[9.5px] text-muted">{aside}</span>
      )}
    </div>
  );
}
