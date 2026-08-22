import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  type AuditEntry,
  type AuditRow,
  CHAIN_DIGITS,
  CHAIN_GENESIS,
  chainEntry,
  correctionEntry,
  escapeCell,
  gateOverrideEntry,
  parseLedger,
  renderLedger,
  renderRow,
  tailChain,
  unescapeCell,
  verifyChain,
} from "./ledger";

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: "2026-07-22T14:03",
    actor: "yh",
    action: "stage-change",
    subject: "REQ-2026-014",
    detail: "awaiting-approval→approved",
    ...overrides,
  };
}

/** Chain a list of entries from genesis, the way the writer does. */
function chainAll(entries: readonly AuditEntry[], seed = CHAIN_GENESIS): AuditRow[] {
  const rows: AuditRow[] = [];
  let previous = seed;
  for (const e of entries) {
    const row = chainEntry(previous, e);
    rows.push(row);
    previous = row.chain;
  }
  return rows;
}

describe("chaining", () => {
  it("produces a fixed-width hex chain value", () => {
    const row = chainEntry(CHAIN_GENESIS, entry());
    expect(row.chain).toHaveLength(CHAIN_DIGITS);
    expect(row.chain).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(chainEntry(CHAIN_GENESIS, entry()).chain).toBe(
      chainEntry(CHAIN_GENESIS, entry()).chain,
    );
  });

  it("depends on the preceding chain value, not just the row", () => {
    const a = chainEntry(CHAIN_GENESIS, entry());
    const b = chainEntry("0000000000000000", entry());
    expect(a.chain).not.toBe(b.chain);
  });

  it("changes when any field changes", () => {
    const base = chainEntry(CHAIN_GENESIS, entry()).chain;
    for (const change of [
      { ts: "2026-07-22T14:04" },
      { actor: "xx" },
      { action: "export" as const },
      { subject: "REQ-2026-015" },
      { detail: "awaiting-approval→delivered" },
    ]) {
      expect(chainEntry(CHAIN_GENESIS, entry(change)).chain).not.toBe(base);
    }
  });

  it("carries the seed across a month boundary", () => {
    const july = chainAll([entry(), entry({ detail: "approved→extraction" })]);
    const august = chainAll([entry({ ts: "2026-08-01T09:00" })], tailChain(july));

    expect(verifyChain(july).ok).toBe(true);
    expect(verifyChain(august, tailChain(july)).ok).toBe(true);
    // Verified against genesis instead, August does not reconcile — which is
    // exactly the failure a lost seed should produce.
    expect(verifyChain(august).ok).toBe(false);
  });

  it("falls back to genesis when there is no previous month", () => {
    expect(tailChain([])).toBe(CHAIN_GENESIS);
  });
});

describe("verifyChain", () => {
  const rows = chainAll([
    entry(),
    entry({ ts: "2026-07-22T14:03", action: "gate-override", detail: "irb_expiry; reason: x" }),
    entry({ ts: "2026-07-23T09:41", action: "export", subject: "VIEW-queue", detail: "42 rows" }),
  ]);

  it("accepts an untouched ledger", () => {
    const result = verifyChain(rows);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.break).toBeUndefined();
  });

  it("accepts an empty ledger", () => {
    expect(verifyChain([])).toEqual({ ok: true, checked: 0 });
  });

  it("detects an edited row and names it", () => {
    const tampered = rows.map((r, i) => (i === 1 ? { ...r, detail: "irb_expiry; reason: y" } : r));
    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.break?.index).toBe(1);
    expect(result.break?.found).toBe(rows[1]!.chain);
    expect(result.break?.expected).not.toBe(rows[1]!.chain);
  });

  it("detects a deleted row", () => {
    const result = verifyChain([rows[0]!, rows[2]!]);
    expect(result.ok).toBe(false);
    expect(result.break?.index).toBe(1);
  });

  it("detects a reordered pair", () => {
    const result = verifyChain([rows[1]!, rows[0]!, rows[2]!]);
    expect(result.ok).toBe(false);
    expect(result.break?.index).toBe(0);
  });

  it("detects a row inserted at the end", () => {
    const forged = [...rows, { ...entry({ action: "delete" as const }), chain: "abcdef0123456789" }];
    const result = verifyChain(forged);
    expect(result.ok).toBe(false);
    expect(result.break?.index).toBe(3);
  });

  it("stops at the first break rather than reporting every later row", () => {
    const tampered = rows.map((r, i) => (i === 0 ? { ...r, actor: "someone-else" } : r));
    expect(verifyChain(tampered).checked).toBe(0);
  });
});

describe("cell escaping", () => {
  it("round-trips pipes, newlines and backslashes", () => {
    for (const value of [
      "plain",
      "reason with | a pipe",
      "line one\nline two",
      "a\\b",
      "\\|",
      "carriage\r\nreturn",
      "",
    ]) {
      expect(unescapeCell(escapeCell(value))).toBe(value.replace(/\r\n?/g, "\n").trim());
    }
  });

  it("never emits a raw pipe or newline into a cell", () => {
    const escaped = escapeCell("a | b\nc");
    expect(escaped).not.toMatch(/(?<!\\)\|/);
    expect(escaped).not.toContain("\n");
  });
});

describe("rendering and parsing", () => {
  it("round-trips a ledger file", () => {
    const rows = chainAll([
      entry(),
      entry({ action: "gate-override", detail: "irb_expiry; reason: letter | pending" }),
      entry({ action: "export", subject: "VIEW-queue", detail: "42 rows → 95 Exports/q.html" }),
    ]);
    const parsed = parseLedger(renderLedger(rows));
    expect(parsed.malformed).toEqual([]);
    expect(parsed.rows).toEqual(rows);
    expect(verifyChain(parsed.rows).ok).toBe(true);
  });

  it("keeps the chain verifiable through a pipe typed in a reason", () => {
    // The escaped text is what gets hashed, so what a reader sees in the file
    // is what they can recompute.
    const rows = chainAll([entry({ detail: "reason: a | b" })]);
    expect(verifyChain(parseLedger(renderLedger(rows)).rows).ok).toBe(true);
  });

  it("ignores prose around the table", () => {
    const rows = chainAll([entry()]);
    const text = `# July 2026\n\nNotes from the month.\n\n${renderLedger(rows)}\nEnd.\n`;
    expect(parseLedger(text).rows).toEqual(rows);
  });

  it("flags rows it cannot read instead of dropping them silently", () => {
    const text = ["| ts | actor | action | subject | detail | chain |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 2026-07-22T14:03 | yh | stage-change | REQ-1 | a→b | deadbeefdeadbeef |",
      "| 2026-07-22T14:04 | yh | not-a-real-action | REQ-1 | x | deadbeefdeadbeef |",
      "| too | few | cells |",
    ].join("\n");
    const parsed = parseLedger(text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.malformed).toEqual([4, 5]);
  });

  it("renders an empty detail as a cell rather than collapsing the row", () => {
    const row = chainEntry(CHAIN_GENESIS, entry({ detail: "" }));
    expect(renderRow(row).split("|")).toHaveLength(8); // 6 cells + 2 outer edges
    expect(parseLedger(renderLedger([row])).rows[0]!.detail).toBe("");
  });
});

describe("gate overrides", () => {
  it("refuses to build an override with no typed reason", () => {
    for (const reason of ["", "   ", "\n"]) {
      expect(() =>
        gateOverrideEntry({
          ts: "2026-07-22T14:03",
          actor: "yh",
          subject: "REQ-2026-014",
          gate: "irb_expiry",
          reason,
        }),
      ).toThrow(/typed reason/i);
    }
  });

  it("records the gate and the reason", () => {
    const e = gateOverrideEntry({
      ts: "2026-07-22T14:03",
      actor: "yh",
      subject: "REQ-2026-014",
      gate: "irb_expiry",
      reason: "extension granted verbally, letter pending",
    });
    expect(e.action).toBe("gate-override");
    expect(e.detail).toBe("irb_expiry; reason: extension granted verbally, letter pending");
  });
});

describe("corrections", () => {
  it("points at the row it corrects and requires a reason", () => {
    const e = correctionEntry({
      ts: "2026-07-23T08:00",
      actor: "yh",
      subject: "REQ-2026-014",
      correctsChain: "a91f4c0011223344",
      reason: "wrong request id",
    });
    expect(e.action).toBe("correction");
    expect(e.detail).toContain("corrects a91f4c0011223344");
    expect(() =>
      correctionEntry({ ...e, correctsChain: "x", reason: " " } as never),
    ).toThrow(/typed reason/i);
  });
});

describe("action vocabulary", () => {
  it("covers every action CLAUDE.md §5.6 requires to be logged", () => {
    for (const action of [
      "stage-change",
      "gate-override",
      "identifier-scope",
      "evidence-added",
      "evidence-removed",
      "delete",
      "export",
      "bulk-edit",
      "schema-migration",
      "settings-change",
    ]) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });
});
