/**
 * What the user is told when Windows refuses to start PowerShell.
 *
 * From a real report on the target machine: enabling the Outlook reader
 * produced "SCDB: could not read outlook. spawn EPERM". That names no cause
 * and offers no next step, which §8 forbids — and worse, it reads like a bug
 * in the plugin when it is a decision the machine has made about what Obsidian
 * is allowed to launch.
 */

import { describe, expect, it } from "vitest";
import { spawnFailureMessage } from "../src/services/outlookBridge";

function nodeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("explaining why powershell.exe would not start", () => {
  it("says EPERM is machine policy, not a fault to hunt for", () => {
    const message = spawnFailureMessage(nodeError("EPERM", "spawn EPERM"));
    expect(message).toMatch(/policy/i);
    // The user must not be sent looking for a setting that cannot exist.
    expect(message).toMatch(/no setting here can override it/i);
  });

  it("points EPERM at the path that still works", () => {
    // Tier 1 needs no PowerShell at all, so the answer to a locked-down
    // machine is a different route, not a dead end.
    expect(spawnFailureMessage(nodeError("EPERM", "spawn EPERM"))).toMatch(
      /dragging a message into the vault/i,
    );
  });

  it("treats EACCES the same way", () => {
    expect(spawnFailureMessage(nodeError("EACCES", "spawn EACCES"))).toMatch(/policy/i);
  });

  it("tells ENOENT apart, because that one really is a missing executable", () => {
    const message = spawnFailureMessage(nodeError("ENOENT", "spawn ENOENT"));
    expect(message).toMatch(/could not be found/i);
    expect(message).not.toMatch(/policy/i);
  });

  it("still quotes the underlying detail for an unknown code", () => {
    expect(spawnFailureMessage(nodeError("EMFILE", "spawn EMFILE"))).toContain("spawn EMFILE");
  });

  it("does not throw on a non-Error", () => {
    expect(spawnFailureMessage("something odd")).toContain("something odd");
    expect(spawnFailureMessage(null)).toContain("null");
  });
});
