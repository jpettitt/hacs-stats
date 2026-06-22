export function renderAboutPage(): string {
  return `
    <h2>What this is</h2>
    <p class="lead">
      hacs-stats is an unofficial dashboard of public usage signals for the
      Home Assistant Community Store. It tracks every repo listed in
      <a href="https://github.com/hacs/default" target="_blank" rel="noopener noreferrer">hacs/default</a>,
      plus user-submitted custom repos, and surfaces stars, downloads, and
      basic health metrics from GitHub.
    </p>

    <h2>Methodology</h2>
    <h3>Downloads are a proxy, not a count</h3>
    <p>
      Home Assistant doesn't phone home, so the true number of installations
      is unknowable. What we count is <strong>GitHub release-asset download
      requests</strong> — specifically the file HACS itself fetches per repo
      (declared in each repo's <code>hacs.json</code> <code>filename</code> field).
      An install corresponds to roughly one download; auto-updates each cause
      another download; a download doesn't imply HACS pulled the file
      (someone might just be browsing GitHub).
    </p>

    <h3>Top version in last 30 days</h3>
    <p>
      For every repo, we snapshot the cumulative download count of its HACS
      asset on each release every day. The "30-day downloads" stat is the
      delta between today's snapshot and the snapshot from 30 days ago,
      summed across all of that repo's releases. The "top version" picks the
      single release with the highest delta — that's "the version people are
      actively pulling right now," tolerant of slow upgraders.
    </p>

    <h3>Stars Δ</h3>
    <p>
      Star deltas compare today's GraphQL-reported star count to the earliest
      snapshot we have within the 7d / 30d window. On day 1 of operation, the
      windows haven't accumulated, so deltas read zero. Genuine.
    </p>

    <h2>Update cadence</h2>
    <ul>
      <li>Repo catalogue (the HACS default lists) — every day.</li>
      <li>Per-repo metadata (stars, forks, issues) — every day via GraphQL.</li>
      <li>Per-repo releases &amp; download counts — every day via REST, with
        ETag caching so repos with no activity skip the round trip.</li>
      <li>Custom-repo discovery (GitHub code search for <code>hacs.json</code>) —
        weekly.</li>
    </ul>

    <h2>Limits we know about</h2>
    <ul>
      <li>Repos that don't declare a <code>filename</code> in their
        <code>hacs.json</code> get their <em>entire</em> release asset list
        summed instead. This overcounts for projects that publish multiple
        zips per release. We're investigating per-kind fallbacks.</li>
      <li>"30-day delta" stats only make sense once we've been running 30+
        days. Until then, the windows are shorter than advertised.</li>
      <li>A repo deleted or made private between scrapes shows up as
        "missing" in the snapshot — we keep the historical data but stop
        refreshing.</li>
    </ul>

    <h2>Not affiliated with HACS</h2>
    <p>
      This is an independent project. It is not run, endorsed, or reviewed by
      the HACS maintainers or by the Home Assistant project. All data is
      sourced from public GitHub APIs.
    </p>

    <h2>Plugin author? Want to be removed?</h2>
    <p>
      File an issue on the
      <a href="https://github.com/jpettitt/hacs-stats" target="_blank" rel="noopener noreferrer">hacs-stats repo</a>
      and we'll exclude your repo from the public lists. (The data itself is
      already public on GitHub; this is just about whether we surface it.)
    </p>
  `;
}
