import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // domain/ is Obsidian-free by design (CLAUDE.md §4), so it needs no DOM and
    // no mocks. If a test here ever needs an Obsidian stub, the boundary has
    // been broken and the fix belongs in the source, not the test.
    environment: "node",
    // domain tests are pure; tests/ holds the fixture guard, which reads
    // test-vault/ from disk and runs it through those same pure parsers.
    include: ["src/domain/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
