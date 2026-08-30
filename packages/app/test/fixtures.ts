const MARKDOWN_FIXTURES = import.meta.glob("./fixtures/markdown/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Read a Markdown fixture by name.
 *
 * The fixtures are inlined at transform time rather than read from disk, so a
 * run finds them whatever directory it starts in, and a name with no fixture
 * behind it fails here rather than as a confusing assertion further down.
 */
export function readMarkdownFixture(name: string): string {
  const content = MARKDOWN_FIXTURES[`./fixtures/markdown/${name}`];

  if (content === undefined) {
    throw new Error(`no Markdown fixture named "${name}"`);
  }

  return content;
}
