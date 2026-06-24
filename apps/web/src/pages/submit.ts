import { escapeHtml } from '../sanitize.js';

export interface SubmitPageProps {
  /** Sticky value from the prior submission so the user doesn't retype. */
  value?: string;
  /** Outcome of the prior submission, if any. */
  message?: { kind: 'ok' | 'err'; text: string };
}

export function renderSubmitPage(props: SubmitPageProps): string {
  const safeVal = escapeHtml(props.value ?? '');
  const msg = props.message
    ? `<p class="${props.message.kind === 'ok' ? 'lead' : 'lead muted'}" style="${
        props.message.kind === 'ok' ? '' : 'color: var(--danger);'
      }">${escapeHtml(props.message.text)}</p>`
    : '';
  return `
    <h2>Submit a custom HACS repo</h2>
    <p class="lead">
      Got a HACS repo that isn't in the
      <a href="https://github.com/hacs/default" target="_blank" rel="noopener noreferrer">hacs/default</a>
      lists yet? Drop the <code>owner/repo</code> here. We'll validate that
      it has a real <code>hacs.json</code> at the root and isn't a
      contribution fork, then queue it for review. Accepted entries land in
      our catalogue on the next daily scrape.
    </p>
    ${msg}
    <form class="filter-bar" action="/submit" method="post">
      <label class="visually-hidden" for="repo">owner/repo</label>
      <input id="repo" type="text" name="repo" value="${safeVal}"
             placeholder="owner/repo (e.g. jpettitt/geo-clock-card)"
             autocomplete="off" required>
      <label class="visually-hidden" for="kind">HACS category</label>
      <select id="kind" name="kind" required>
        <option value="">— category —</option>
        <option value="integration">Integration</option>
        <option value="plugin">Plugin / Lovelace card</option>
        <option value="theme">Theme</option>
        <option value="appdaemon">AppDaemon</option>
        <option value="netdaemon">NetDaemon</option>
        <option value="python_script">Python script</option>
        <option value="template">Template</option>
      </select>
      <button type="submit">Submit</button>
    </form>
    <h3>What we check</h3>
    <ul>
      <li>The repo exists and is public.</li>
      <li>It's not a fork (forks can still be submitted by their
        maintainer if the upstream is dead — we accept those, but ban
        the auto-discovery worker from queueing them).</li>
      <li>It has a <code>hacs.json</code> at the repository root (not in a
        subdirectory).</li>
      <li>The <code>hacs.json</code> contains at least one HACS-meaningful
        field (<code>name</code>, <code>filename</code>, <code>domain</code>,
        etc.) — rules out false positives.</li>
    </ul>
  `;
}
