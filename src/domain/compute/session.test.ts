import { describe, expect, it } from "vitest";
import {
  cellFile,
  cellId,
  heldBack,
  isSessionToken,
  parseEnvironment,
  runCommand,
  SessionParser,
  type SessionEvent,
} from "./session";

const TOKEN = "a1b2c3d4e5f60718";

function texts(events: SessionEvent[]): string {
  return events
    .filter((event): event is Extract<SessionEvent, { kind: "text" }> => event.kind === "text")
    .map((event) => event.text)
    .join("");
}

describe("the protocol line", () => {
  it("carries a name, never code", () => {
    expect(runCommand("0007")).toBe("SCDB-RUN 0007\n");
    expect(cellFile("python", "0007")).toBe("cell-0007.py");
    expect(cellFile("r", "0007")).toBe("cell-0007.R");
  });

  // Pure ASCII on the wire, so however Windows encodes a pipe the framing
  // survives it. Encoding is then a question only about the cell file, where
  // both sides say UTF-8 out loud.
  it("is ASCII whatever the cell contains", () => {
    expect(runCommand(cellId(42))).toMatch(/^[\x20-\x7e]+\n$/);
  });

  it("numbers cells so they sort", () => {
    expect(cellId(1)).toBe("0001");
    expect(cellId(1234)).toBe("1234");
  });
});

describe("the session token", () => {
  it("insists on the shape it builds a regex from", () => {
    expect(isSessionToken(TOKEN)).toBe(true);
    expect(isSessionToken("nope")).toBe(false);
    expect(isSessionToken(`${TOKEN}|(evil)`)).toBe(false);
    expect(() => new SessionParser("(.*)")).toThrow();
  });
});

describe("attributing output to a cell", () => {
  it("passes ordinary output straight through", () => {
    const parser = new SessionParser(TOKEN);
    expect(texts(parser.push("stdout", "hello\n"))).toBe("hello\n");
  });

  it("reads the end marker as a result, not as output", () => {
    const parser = new SessionParser(TOKEN);
    const events = parser.push("stdout", `[1] 5.5\n<<SCDB ${TOKEN} END 0003 0 2>>`);
    expect(texts(events)).toBe("[1] 5.5\n");
    expect(events.at(-1)).toEqual({ kind: "end", cell: "0003", status: 0, figures: 2 });
  });

  it("reads stderr's own marker, which is what says the errors are all in", () => {
    const parser = new SessionParser(TOKEN);
    const events = parser.push("stderr", `boom\n<<SCDB ${TOKEN} ERR 0003>>`);
    expect(texts(events)).toBe("boom\n");
    expect(events.at(-1)).toEqual({ kind: "errEnd", cell: "0003" });
  });

  /**
   * The reason this is a class and not a regex at the call site.
   *
   * Chunks arrive on OS timing, so a marker can be cut anywhere at all. Split
   * badly enough, half of one would be printed as output and the cell would
   * never be seen to end. Every split is tried rather than a chosen few,
   * because the one that breaks is always the one nobody thought of.
   */
  it("survives a marker cut at every possible point", () => {
    const whole = `done\n<<SCDB ${TOKEN} END 0001 0 0>>`;
    for (let cut = 0; cut <= whole.length; cut += 1) {
      const parser = new SessionParser(TOKEN);
      const events = [
        ...parser.push("stdout", whole.slice(0, cut)),
        ...parser.push("stdout", whole.slice(cut)),
      ];
      expect(texts(events), `split at ${cut}`).toBe("done\n");
      expect(events.filter((event) => event.kind === "end")).toHaveLength(1);
    }
  });

  it("holds back a tail that could still become a marker", () => {
    const parser = new SessionParser(TOKEN);
    expect(texts(parser.push("stdout", "a<<S"))).toBe("a");
    expect(texts(parser.push("stdout", "CDB "))).toBe("");
    expect(texts(parser.push("stdout", `${TOKEN} END 0001 0 0>>`))).toBe("");
  });

  // Long-running output must appear as it happens. Holding everything until a
  // marker arrived would make a loop that prints for a minute look like a
  // console that had frozen for a minute.
  it("releases text that cannot be a marker immediately", () => {
    const parser = new SessionParser(TOKEN);
    expect(texts(parser.push("stdout", "step 1\nstep 2\n"))).toBe("step 1\nstep 2\n");
  });

  it("treats a marker in somebody else's token as ordinary output", () => {
    const parser = new SessionParser(TOKEN);
    const line = "<<SCDB 0000000000000000 END 0001 0 0>>";
    const events = parser.push("stdout", line);
    expect(events.every((event) => event.kind === "text")).toBe(true);
    expect(texts(events)).toBe(line);
  });

  it("finds two markers in one chunk", () => {
    const parser = new SessionParser(TOKEN);
    const events = parser.push(
      "stdout",
      `a\n<<SCDB ${TOKEN} END 0001 0 0>>b\n<<SCDB ${TOKEN} END 0002 1 0>>`,
    );
    expect(events.filter((event) => event.kind === "end")).toHaveLength(2);
    expect(texts(events)).toBe("a\nb\n");
  });

  it("reads a non-zero status and a figure count", () => {
    const parser = new SessionParser(TOKEN);
    const events = parser.push("stdout", `<<SCDB ${TOKEN} END 0009 1 3>>`);
    expect(events[0]).toEqual({ kind: "end", cell: "0009", status: 1, figures: 3 });
  });
});

/**
 * A marker carries no newlines of its own.
 *
 * It used to. The harness wrote one before each marker and the parser took it
 * back off again as punctuation — which worked only while the two arrived in
 * the same chunk. When the boundary fell between them, that newline was
 * released as output and a blank line appeared before the result:
 * intermittently, on OS chunking, which is the worst way to find anything.
 * These pin the arrangement that has nothing positional left to get wrong.
 */
describe("what surrounds a marker", () => {
  it("removes the marker and leaves the output exactly as it was", () => {
    const parser = new SessionParser(TOKEN);
    expect(texts(parser.push("stdout", `x\n<<SCDB ${TOKEN} END 0001 0 0>>`))).toBe("x\n");
  });

  it("does not invent a newline for output that never had one", () => {
    const parser = new SessionParser(TOKEN);
    expect(texts(parser.push("stdout", `x<<SCDB ${TOKEN} END 0001 0 0>>`))).toBe("x");
  });

  it("keeps a blank line somebody printed on purpose", () => {
    const parser = new SessionParser(TOKEN);
    expect(texts(parser.push("stdout", `x\n\n<<SCDB ${TOKEN} END 0001 0 0>>`))).toBe("x\n\n");
  });

  it("leaves Windows line endings alone", () => {
    const parser = new SessionParser(TOKEN);
    expect(texts(parser.push("stdout", `x\r\n<<SCDB ${TOKEN} END 0001 0 0>>`))).toBe("x\r\n");
  });
});

describe("when the process ends mid-sentence", () => {
  // Whatever was held as a possible marker is not one: the process is gone and
  // no completion is coming. Output is never silently dropped.
  it("releases what was being held back", () => {
    const parser = new SessionParser(TOKEN);
    expect(texts(parser.push("stdout", "half a line <<SCDB "))).toBe("half a line ");
    expect(texts(parser.flush("stdout"))).toBe("<<SCDB ");
  });
});

describe("how much is held back", () => {
  it("holds a started marker until it closes", () => {
    const started = `<<SCDB ${TOKEN} END 0001 0 0`;
    expect(heldBack(started)).toBe(started.length);
  });

  it("holds a prefix of the opening", () => {
    expect(heldBack("output <<")).toBe(2);
    expect(heldBack("output <<SCDB")).toBe(6);
  });

  it("holds nothing when nothing could become a marker", () => {
    expect(heldBack("ordinary output\n")).toBe(0);
    expect(heldBack("a < b")).toBe(0);
  });
});

describe("the environment listing", () => {
  // Tab-separated because base R has no JSON writer, and §7 F1's argument for
  // --vanilla is that we do not get to assume a package is installed.
  it("reads what both harnesses write", () => {
    expect(parseEnvironment("x\tinteger\t10\t int [1:10] 1 2 3\ndf\tdata.frame\t3x2\t3 obs.\n")).toEqual([
      { name: "df", kind: "data.frame", size: "3x2", summary: "3 obs." },
      { name: "x", kind: "integer", size: "10", summary: " int [1:10] 1 2 3" },
    ]);
  });

  it("sorts by name, so a row does not move when its value changes", () => {
    const rows = parseEnvironment("z\tint\t1\t\na\tint\t1\t\n");
    expect(rows.map((row) => row.name)).toEqual(["a", "z"]);
  });

  it("copes with a short row rather than dropping it", () => {
    expect(parseEnvironment("lonely")).toEqual([{ name: "lonely", kind: "", size: "", summary: "" }]);
  });

  it("is empty when nothing has been defined", () => {
    expect(parseEnvironment("")).toEqual([]);
    expect(parseEnvironment("\n\n")).toEqual([]);
  });
});
