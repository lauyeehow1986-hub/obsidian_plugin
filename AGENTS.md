# AGENTS.md — SCDB Cockpit (Obsidian plugin)

**The spec lives in [CLAUDE.md](CLAUDE.md). Read it before writing any code.**

This file is a pointer, deliberately. An earlier version duplicated all 1,100+ lines
of CLAUDE.md so that Codex and Claude each had their own copy — two copies of one
spec drift silently, and a governance spec that quietly disagrees with itself is
worse than no spec. There is one source of truth.

CLAUDE.md covers, in order: what this plugin is (§1), the twelve non-negotiable
rules (§2), how code reaches the locked-down work laptop (§3), stack and
architecture (§4), the vault contract — folders and frontmatter (§5), design
language (§6), the phased build tracks (§7), coding conventions (§8), testing
(§9), release (§10), and the open questions that block specific phases (§11).

Everything in it applies to every agent working in this repository, whichever
tool you are. Where it says "Claude", read it as "you".
