import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A specification fixture as `docs/spec/fixtures/` stores it: one Markdown
 * document together with the review layer a conforming reader extracts from it.
 *
 * `comments` and `suggestions` stay `unknown[]` here. What a record must look
 * like is `docs/spec/roughdraft-flavored-markdown.schema.json`'s to say, and a
 * structural type in this file would be a second, silently diverging copy of
 * that answer.
 */
export interface ReviewFixture {
  source: { markdown: string };
  comments: unknown[];
  suggestions: unknown[];
}

const fixturesDirectory = fileURLToPath(
  new URL("../../../docs/spec/fixtures/", import.meta.url),
);

/**
 * Every specification fixture, in a stable order so a table-driven test names
 * its cases the same way on every machine.
 *
 * A test that wants one projection of these — just the Markdown bodies, say —
 * maps over the result rather than reading the directory a second time.
 */
export function readFixtures(): { name: string; fixture: ReviewFixture }[] {
  return readdirSync(fixturesDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      fixture: JSON.parse(
        readFileSync(join(fixturesDirectory, name), "utf8"),
      ) as ReviewFixture,
    }));
}

/**
 * The Markdown body of one fixture, by file name.
 *
 * Throws when no such fixture exists: a test naming a fixture that is not there
 * is a defect in the test, not a case to skip.
 */
export function fixtureMarkdown(name: string): string {
  const found = readFixtures().find((entry) => entry.name === name);
  if (!found) throw new Error(`Not a specification fixture: ${name}`);
  return found.fixture.source.markdown;
}
