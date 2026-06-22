export interface HomeProps {
  repoCount: number;
}

export function renderHome({ repoCount }: HomeProps): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hacs-stats — design phase</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { margin: 0 0 .5rem; }
    .lead { color: #555; }
    .stat { margin: 2rem 0; padding: 1rem 1.25rem; background: #f3f4f6; border-radius: .5rem; }
    code { background: #e5e7eb; padding: .1rem .3rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <h1>hacs-stats</h1>
  <p class="lead">Unofficial usage stats for HACS — Home Assistant Community Store.</p>
  <div class="stat">Tracking <strong>${repoCount}</strong> repositories.</div>
  <p>Phase 1 scaffold. See <code>ARCHITECTURE.md</code> for the design.</p>
</body>
</html>`;
}
