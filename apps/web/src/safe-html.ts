/**
 * Safe-by-construction HTML — the goog.html.SafeHtml pattern, sized for
 * this codebase.
 *
 * The problem it solves: with bare template literals, every interpolation
 * of GitHub-derived data (repo names, descriptions, release tags, queue
 * notes) needs a hand-written escapeHtml() call, and ONE forgotten call
 * anywhere is an XSS. Safety by vigilance doesn't scale.
 *
 * The inversion: render functions build markup with the html`` tag, which
 * escapes every interpolated value BY DEFAULT. Already-built SafeHtml
 * fragments compose without double-escaping; everything else is treated
 * as hostile text. The compiler enforces the boundary — renderLayout only
 * accepts SafeHtml, so a raw string can't reach the response without
 * going through the escaper or an explicit, greppable raw() call.
 *
 * Rules of use:
 *   - Attribute values MUST be quoted in the template ("${v}", not ${v})
 *     — escapeHtml covers quoted-attribute breakout, not unquoted.
 *   - raw() is for compile-time constants (CSS, static SVG) and strings
 *     made safe by construction elsewhere (jsonLdScript output, validated
 *     URLs are NOT in this category — interpolate them normally and let
 *     attribute escaping apply). Every raw() call is an auditable claim.
 *   - null/undefined interpolations are compile errors on purpose: write
 *     `${x ?? ''}` so "what renders when it's missing" is visible in the
 *     template, not decided by the helper.
 */
import { escapeHtml } from './sanitize.js';

/** Values html`` accepts. Arrays nest (e.g. rows.map(...) interpolates
 * directly, no .join('') needed). */
export type HtmlValue = SafeHtml | string | number | ReadonlyArray<HtmlValue>;

export class SafeHtml {
  readonly #content: string;

  private constructor(content: string) {
    this.#content = content;
  }

  toString(): string {
    return this.#content;
  }

  /** Module-internal factory. Not for use outside this file — go through
   * html`` or raw() so intent stays greppable. */
  static _unchecked(content: string): SafeHtml {
    return new SafeHtml(content);
  }
}

function serialize(v: HtmlValue): string {
  if (v instanceof SafeHtml) return v.toString();
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(serialize).join('');
  // Type-system bypass (an `any` slipped through): fail SAFE by escaping
  // the stringification rather than throwing — a garbled cell beats a 500,
  // and an injected payload beats neither.
  return escapeHtml(String(v));
}

/** Tagged template: html`<p>${untrusted}</p>` → SafeHtml with the
 * interpolation escaped. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += serialize(values[i] as HtmlValue) + (strings[i + 1] ?? '');
  }
  return SafeHtml._unchecked(out);
}

/** Join values with a separator, escaping each per the html`` rules
 * (the `tags.join(' ')` pattern — array interpolation alone joins with ''). */
export function joinHtml(values: readonly HtmlValue[], separator = ''): SafeHtml {
  return SafeHtml._unchecked(values.map(serialize).join(escapeHtml(separator)));
}

/**
 * Unchecked conversion — the escape hatch. The argument is emitted
 * verbatim, so the caller is asserting it contains no attacker-influenced
 * bytes. Keep call sites rare and each one justifiable in review.
 */
export function raw(content: string): SafeHtml {
  return SafeHtml._unchecked(content);
}
