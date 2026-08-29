---
type: vault-app
id: APP-invented-triage
title: Invented triage helper
description: Offers to raise the priority of invented requests that have sat too long.
capabilities:
  query: [scdb-request]
  write: propose
  network: false
export: denied
updated: 2026-08-29
---

# Invented triage helper

**Invented, and the fixture for the write path.** It is the only app here that
declares `write: propose`, so it exercises the rule that matters most: an app
never changes a note. It hands the plugin a proposal, the plugin shows you
every field that would move and both values, and nothing is written unless you
say so.

Note `export: denied` in its own manifest. An app that composes changes is not
one you hand to a colleague as a page, and the note says so rather than relying
on anybody remembering.

Try pressing the button with the plugin's audit ledger open: confirming writes
a `bulk-edit` row and an `app-write` row naming this app as the origin.

```js app
const Triage = () => {
  const { rows, loading, error, reload } = useQuery({ types: ["scdb-request"] });
  const propose = useProposeWrite();
  const [said, setSaid] = useState("");

  if (loading) return html`<p>Loading…</p>`;
  if (error) return html`<p class="scdb-app-error">${error}</p>`;

  const normal = rows.filter((row) => (row.priority ?? "normal") === "normal");

  const raise = async (row) => {
    try {
      const answer = await propose({
        path: row.path,
        frontmatter: { priority: "high" },
        reason: "Invented rule: it has been in this stage longer than the others.",
      });
      setSaid(answer.applied ? `Updated ${row.id}.` : answer.reason ?? "Nothing to change.");
      reload();
    } catch (refusal) {
      setSaid(String(refusal.message ?? refusal));
    }
  };

  return html`
    <h2>${normal.length} invented requests at normal priority</h2>
    ${said === "" ? null : html`<p class="scdb-app-note">${said}</p>`}
    <table>
      <thead><tr><th>request</th><th>stage</th><th></th></tr></thead>
      <tbody>
        ${normal.map((row) => html`
          <tr key=${row.path}>
            <td>${row.id ?? row.path}</td>
            <td>${row.stage ?? ""}</td>
            <td><button onClick=${() => raise(row)}>Propose high priority</button></td>
          </tr>
        `)}
      </tbody>
    </table>
  `;
};

mount(Triage);
```
