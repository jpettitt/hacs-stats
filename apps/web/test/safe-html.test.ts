import { describe, expect, it } from 'vitest';
import { SafeHtml, html, raw } from '../src/safe-html.js';

describe('html tagged template', () => {
  it('escapes interpolated strings by default', () => {
    const out = html`<p>${'<script>alert(1)</script>'}</p>`.toString();
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes quote/backtick breakouts in attribute position', () => {
    const out = html`<a title="${'" onmouseover="alert(1)'}">x</a>`.toString();
    expect(out).not.toContain('" onmouseover');
    expect(out).toContain('&quot; onmouseover=&quot;alert(1)');
  });

  it('composes nested SafeHtml without double-escaping', () => {
    const cell = html`<td>${'A & B'}</td>`;
    const row = html`<tr>${cell}</tr>`.toString();
    expect(row).toBe('<tr><td>A &amp; B</td></tr>');
    expect(row).not.toContain('&amp;amp;');
  });

  it('joins arrays inline (the rows.map pattern)', () => {
    const rows = ['a<b', 'c'].map((s) => html`<li>${s}</li>`);
    expect(html`<ul>${rows}</ul>`.toString()).toBe('<ul><li>a&lt;b</li><li>c</li></ul>');
  });

  it('passes numbers through unescaped', () => {
    expect(html`<td>${1234}</td>`.toString()).toBe('<td>1234</td>');
  });

  it('fails safe on a type-system bypass', () => {
    const evil = { toString: () => '<img onerror=alert(1) src=x>' };
    // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the type to test the runtime net
    const out = html`<p>${evil as any}</p>`.toString();
    expect(out).not.toContain('<img');
  });

  it('raw() passes through verbatim and only SafeHtml is trusted', () => {
    expect(html`<div>${raw('<b>ok</b>')}</div>`.toString()).toBe('<div><b>ok</b></div>');
    // A plain string that LOOKS like SafeHtml output is still escaped.
    const laundered: string = html`<b>x</b>`.toString();
    expect(html`<div>${laundered}</div>`.toString()).toBe('<div>&lt;b&gt;x&lt;/b&gt;</div>');
  });

  it('SafeHtml survives instanceof across composition', () => {
    expect(html`<i>a</i>`).toBeInstanceOf(SafeHtml);
  });
});
