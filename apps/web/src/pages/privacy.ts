/**
 * /privacy — plain-language privacy disclosure. Surfaces what we collect,
 * what cookies are set (Google Analytics 4), and who the
 * data flows to. Linked from the footer.
 *
 * Kept as static HTML rather than a real CMS — the policy changes once a
 * year at most, and putting it in version control keeps the audit trail
 * obvious ("when did we add Google Analytics?" = `git log -p`).
 */
export function renderPrivacyPage(): string {
  return `
    <h2>Privacy</h2>

    <p class="lead">hacs-stats is a public dashboard of GitHub repository
    statistics. We do not require accounts, do not accept user uploads
    beyond the repo URL on /submit, and do not sell or share visitor
    data with third parties beyond what's listed below.</p>

    <section>
      <h3>What we collect from visitors</h3>
      <p><strong>Server logs.</strong> Caddy (our reverse proxy) and the
      Node app log requests with IP address, user agent, referrer, and
      request path. Logs are kept for 30 days for operational
      troubleshooting and then rotated. They are not used for analytics
      or shared with anyone.</p>

      <p><strong>Google Analytics 4.</strong> Every page loads Google's
      <code>gtag.js</code> and reports page views to Google Analytics
      property <code>G-PG9GF2C20Q</code>. We use this to understand
      which pages are useful and which aren't. GA4 sets the cookies
      <code>_ga</code> and <code>_ga_PG9GF2C20Q</code> on your browser
      (typically 13&nbsp;months expiry). Google may use the data
      subject to <a href="https://policies.google.com/privacy"
      target="_blank" rel="noopener noreferrer">their privacy policy</a>.</p>

      <p><strong>Cloudflare Web Analytics.</strong> Cloudflare (our CDN)
      auto-injects a small beacon script
      (<code>static.cloudflareinsights.com/beacon.min.js</code>) that
      reports page views to <code>cloudflareinsights.com</code>.
      Cookieless and IP-anonymised — Cloudflare uses sampling and
      aggregation rather than persistent identifiers. We use it for
      privacy-respecting performance and traffic insight that doesn't
      depend on the user accepting cookies. See
      <a href="https://www.cloudflare.com/web-analytics-privacy/"
      target="_blank" rel="noopener noreferrer">Cloudflare's
      explanation</a>.</p>

      <p>We do not run any other third-party trackers, ads, or
      fingerprinting libraries. There is no embedded social-media
      content. The outbound requests your browser makes from our
      pages are limited to <code>googletagmanager.com</code> +
      <code>google-analytics.com</code> (Google Analytics),
      <code>static.cloudflareinsights.com</code> +
      <code>cloudflareinsights.com</code> (Cloudflare analytics),
      and <code>github.com</code> when you click a repo link.</p>
    </section>

    <section>
      <h3>Cookies</h3>
      <table>
        <thead><tr><th>Cookie</th><th>Source</th><th>Purpose</th><th>Lifetime</th></tr></thead>
        <tbody>
          <tr><td><code>_ga</code></td><td>Google Analytics</td><td>Distinguishes unique visitors</td><td>2 years</td></tr>
          <tr><td><code>_ga_PG9GF2C20Q</code></td><td>Google Analytics</td><td>Persists session state</td><td>2 years</td></tr>
        </tbody>
      </table>
      <p class="muted small">You can block these by enabling
      "Do Not Track" / blocking third-party cookies in your browser, or
      by installing an extension like uBlock Origin. The site continues
      to work fully without them.</p>
    </section>

    <section>
      <h3>What we collect about GitHub repositories</h3>
      <p>Everything we display is fetched from GitHub's public REST and
      GraphQL APIs — stars, forks, release downloads, descriptions,
      hacs.json metadata. We do not display any data that is not already
      public on GitHub. If you are a repo author and would prefer your
      repository not to be listed, open an issue and we'll suppress it.</p>
    </section>

    <section>
      <h3>Submissions</h3>
      <p>If you use the <a href="/submit">Submit</a> form, the GitHub
      repository identifier you enter is recorded in our database along
      with the timestamp. No other personal information is collected.</p>
    </section>

    <section>
      <h3>Changes</h3>
      <p>If we change what we collect we'll update this page; the change
      is also visible in the project's git history.</p>
    </section>

    <p class="muted small">Last updated: 2026-06-27.</p>
  `;
}
