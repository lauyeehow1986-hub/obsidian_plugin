---
type: vault-app
id: APP-invented-queue
title: Invented queue by stage
description: Counts the invented requests in each stage, and shows the oldest.
capabilities:
  query: [scdb-request]
  write: none
  network: false
export: allowed
updated: 2026-08-29
---

# Invented queue by stage

**Invented, and deliberately ordinary.** It reads one note type, writes nothing
and asks for nothing else — the shape most useful apps will have.

It is the fixture that proves an app can be granted, run, and exported. The
first time it runs the plugin will ask whether it may read `scdb-request`;
after that it runs on one click, until its `capabilities:` block asks for more.

```js app
const Queue = () => {
  const { rows, loading, error } = useQuery({ types: ["scdb-request"] });

  if (loading) return html`<p>Loading…</p>`;
  if (error) return html`<p class="scdb-app-error">${error}</p>`;

  const byStage = new Map();
  for (const row of rows) {
    const stage = row.stage ?? "(no stage)";
    byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
  }
  const stages = [...byStage.entries()].sort((a, b) => b[1] - a[1]);

  return html`
    <h2>${rows.length} invented requests</h2>
    ${snapshotTakenAt === "" ? null : html`<p class="scdb-app-note">Snapshot taken ${snapshotTakenAt}.</p>`}
    <table>
      <thead><tr><th>stage</th><th class="num">requests</th></tr></thead>
      <tbody>
        ${stages.map(([stage, n]) => html`
          <tr key=${stage}><td>${stage}</td><td class="num">${n}</td></tr>
        `)}
      </tbody>
    </table>
  `;
};

mount(Queue);
```
