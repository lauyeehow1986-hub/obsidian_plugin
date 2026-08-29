---
type: vault-app
id: APP-invented-overreach
title: Invented overreaching app
description: Asks for things no app is given, so the refusals can be seen.
capabilities:
  query: [scdb-request, correspondence]
  write: propose
  network: true
export: allowed
updated: 2026-08-29
---

# Invented overreaching app

**Invented, and deliberately greedy.** Three things about it are worth reading
before it runs, and the board says all three without running anything:

- It asks for **network access**, which no vault app is ever given. The
  manifest parses, the request is reported, and it is granted `false` — the
  sandbox blocks outbound requests and the broker has no code path that could
  make one.
- It asks for **correspondence**, which holds full message bodies. Granting
  that is a real decision, which is why the consent dialog names the type
  rather than saying "reads some notes".
- Its code then tries four things it should not be able to do, and prints what
  came back. That is the fixture: each guard is somewhere the app cannot reach
  — the broker, the manifest, the browser's own policy — rather than in the app
  choosing to behave.

The fourth is the one worth watching. `sandbox="allow-scripts"` does **not**
stop a network call; a sandboxed frame can still `fetch()` a public host. What
stops it is the `default-src 'none'` content-security policy the page carries.
Rules 3 and 4 rest on that, so this app tries it and reports what happened.

```js app
const Overreach = () => {
  const granted = useQuery({ types: ["scdb-request"] });
  const [refusals, setRefusals] = useState([]);

  useEffect(() => {
    const collect = async () => {
      const found = [];

      try {
        await query({ types: ["publication"] });
        found.push("Read a type it was not granted — this should not have happened.");
      } catch (refusal) {
        found.push(`Type outside the manifest: ${refusal.message}`);
      }

      try {
        await notes("vault-app");
        found.push("Read the app notes themselves — this should not have happened.");
      } catch (refusal) {
        found.push(`Reading other apps: ${refusal.message}`);
      }

      try {
        await proposeWrite({
          path: granted.rows[0]?.path ?? "",
          frontmatter: { history: [] },
          reason: "Invented attempt to rewrite history.",
        });
        found.push("Rewrote history — this should not have happened.");
      } catch (refusal) {
        found.push(`Protected field: ${refusal.message}`);
      }

      try {
        await fetch("https://example.com/");
        found.push("Reached the network — this should not have happened.");
      } catch (refusal) {
        found.push(`Network: blocked by the page's content-security policy (${refusal.name}).`);
      }

      setRefusals(found);
    };
    if (!granted.loading) void collect();
  }, [granted.loading]);

  return html`
    <h2>What this app was refused</h2>
    <p class="scdb-app-note">It reached ${granted.rows.length} requests, which it was granted.</p>
    <ul>${refusals.map((line) => html`<li key=${line}>${line}</li>`)}</ul>
  `;
};

mount(Overreach);
```
