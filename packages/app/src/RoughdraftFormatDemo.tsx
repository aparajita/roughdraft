import { ArrowRight } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "./components/ui/button";
import { MarkdownCodeEditor } from "./MarkdownCodeEditor";
import { PageCard } from "./PageCard";
import type { Page, StorageBackend } from "./storage";

interface FormatExample {
  id: string;
  label: string;
  markdown: string;
}

const FORMAT_EXAMPLES: FormatExample[] = [
  {
    id: "plan-review",
    label: "Review a plan",
    markdown:
      '# Homepage Conversion Plan\nGoal: make the homepage workflow story and Markdown proof feel like one continuous example.\n\nMove the workflow story above <span id="rd-c1">"It\'s just Markdown."</span>\n\n<span id="rd-s1"><del>Review an agent\'s plan</del><ins>Review a homepage plan</ins></span> before it starts coding.\n\nKeep the format section as proof that the review data is portable Markdown.\n\n---\nroughdraft: "1.0"\ncomments:\n  rd-c1:\n    body: This should go above "It\'s just Markdown."\n    by: Nora\n    at: "2026-04-28T12:10:00.000Z"\n  rd-c2:\n    body: Sounds good. I\'ll move it above that section.\n    by: AI\n    at: "2026-04-28T12:11:00.000Z"\n    re: rd-c1\nsuggestions:\n  rd-s1:\n    by: Nora\n    at: "2026-04-28T12:12:00.000Z"\n',
  },
  {
    id: "spec-review",
    label: "Review a spec",
    markdown:
      '# Checkout Spec Review\nGoal: reduce trial checkout abandonment by 8%. Scope: ship <span id="rd-c1">guest checkout for returning teams</span> in the first beta.\n\nMetric: replace <span id="rd-s1"><del>activation</del><ins>first successful team purchase</ins></span> before engineering sizing.\n\n---\nroughdraft: "1.0"\ncomments:\n  rd-c1:\n    body: "PM: confirm whether this excludes SSO-only workspaces."\n    by: user\n    at: "2026-04-28T12:00:00.000Z"\nsuggestions:\n  rd-s1:\n    by: user\n    at: "2026-04-28T12:03:00.000Z"\n',
  },
  {
    id: "writing-edit",
    label: "Edit writing",
    markdown:
      '## Draft Intro\nRoughdraft lets me stay in flow while an agent marks up <span id="rd-c1">my argument</span>.\n\nIt turns feedback from <span id="rd-s1"><del>a confusing pile of notes</del><ins>specific comments and suggested edits inside the Markdown file</ins></span>.\n\n---\nroughdraft: "1.0"\ncomments:\n  rd-c1:\n    body: "AI: this is the claim readers need to understand first."\n    by: AI\n    at: "2026-04-28T12:20:00.000Z"\n  rd-c2:\n    body: "User: keep the plain-English phrasing, but avoid making it sound like a docs product."\n    by: user\n    at: "2026-04-28T12:22:00.000Z"\n    re: rd-s1\nsuggestions:\n  rd-s1:\n    by: AI\n    at: "2026-04-28T12:21:00.000Z"\n',
  },
];

const demoBackend: StorageBackend = {
  info: {
    kind: "local-storage",
    label: "Homepage demo",
    detail: "In-memory Roughdraft format preview",
  },
  canManageProjects: false,
  async getMarkdownFile() {
    return {
      id: "homepage-format-preview",
      title: "homepage-format-preview.md",
      content: FORMAT_EXAMPLES[0].markdown,
    };
  },
  async saveMarkdownFile(_relativePath, content) {
    return {
      id: "homepage-format-preview",
      title: "homepage-format-preview.md",
      content,
    };
  },
  async saveAsset(file) {
    return {
      markdownPath: file.name,
      previewUrl: "",
      mimeType: file.type || "application/octet-stream",
    };
  },
  resolveFileUrl() {
    return null;
  },
  async openProject() {},
};

export function RoughdraftFormatDemo() {
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(
    FORMAT_EXAMPLES[0].id,
  );
  const [source, setSource] = useState(FORMAT_EXAMPLES[0].markdown);
  const page: Page = useMemo(
    () => ({
      id: "homepage-format-preview",
      title: "homepage-format-preview.md",
      content: source,
    }),
    [source],
  );

  const handleSelectExample = useCallback((example: FormatExample) => {
    setSelectedExampleId(example.id);
    setSource(example.markdown);
  }, []);

  const handleSourceChange = useCallback((nextSource: string) => {
    setSelectedExampleId(null);
    setSource(nextSource);
  }, []);

  const handleResultChange = useCallback((nextSource: string) => {
    setSelectedExampleId(null);
    setSource(nextSource);
  }, []);

  return (
    <section
      aria-labelledby="roughdraft-markdown-heading"
      data-testid="rfm-format-demo"
      className="rfm-format-demo mx-auto mt-20 w-full max-w-none border-t border-slate-200 pt-10 text-left dark:border-slate-700 sm:mt-24"
    >
      <div
        className="rfm-format-demo-intro font-die-grotesk-a mx-auto w-full px-4 font-bold"
        data-testid="rfm-format-demo-intro"
      >
        <div className="max-w-3xl">
          <p className="text-xs font-bold tracking-[0.16em] text-stone-500 uppercase dark:text-stone-400">
            Roughdraft flavored Markdown
          </p>
          <h2
            className="font-die-grotesk-b mt-3 text-3xl leading-tight font-bold text-balance text-slate-950 dark:text-slate-50 sm:text-4xl"
            id="roughdraft-markdown-heading"
          >
            It's just Markdown
          </h2>
          <p className="mt-4 text-base leading-7 text-stone-600 dark:text-stone-400">
            We extended the markdown format with ordinary HTML anchors and a
            YAML endmatter block, to support full comment threads, and
            suggesting changes. Read the{" "}
            <a
              className="font-bold text-slate-950 underline decoration-slate-300 underline-offset-4 hover:decoration-slate-950 dark:text-slate-50 dark:decoration-slate-600 dark:hover:decoration-slate-50"
              href="/roughdraft-flavored-markdown"
            >
              spec
            </a>
            . We are working with other major Markdown apps to rally support for
            this initiative.
          </p>
        </div>
      </div>

      <div
        className="rfm-format-demo-examples mx-auto mt-5 flex w-full flex-wrap gap-2 px-4"
        data-testid="rfm-format-demo-examples"
        role="group"
        aria-label="Format examples"
      >
        {FORMAT_EXAMPLES.map((example) => (
          <Button
            className="h-8 px-3 text-xs"
            data-testid={`rfm-format-example-${example.id}`}
            key={example.id}
            type="button"
            variant={selectedExampleId === example.id ? "default" : "outline"}
            onClick={() => handleSelectExample(example)}
          >
            {example.label}
          </Button>
        ))}
      </div>

      <div
        className="mx-auto mt-5 grid w-full gap-3 lg:grid-cols-[minmax(20rem,0.72fr)_2.5rem_minmax(0,1.28fr)] lg:items-stretch"
        data-testid="rfm-format-demo-grid"
      >
        <div
          className="flex min-w-0 flex-col overflow-visible rounded-lg border-0 bg-transparent shadow-none"
          data-testid="rfm-source-pane"
        >
          <div className="flex h-10 items-center justify-end border-b border-transparent px-4 text-xs font-semibold tracking-[0.14em] text-stone-500 uppercase dark:text-slate-400">
            <span>Source</span>
          </div>
          <div className="relative m-4 flex min-h-[calc(70vh+7rem)] flex-col overflow-hidden rounded-lg border border-slate-950/70 bg-[#1F232B] text-slate-50 shadow-[0_20px_48px_rgba(15,23,42,0.16)] before:absolute before:top-0 before:right-0 before:left-0 before:flex before:min-h-10 before:items-center before:border-b before:border-slate-400/20 before:px-3.5 before:pl-[4.5rem] before:font-mono before:text-xs before:font-bold before:text-slate-300 before:content-['markdown_source'] after:absolute after:top-[0.925rem] after:left-3.5 after:size-[0.65rem] after:rounded-full after:bg-rose-500 after:shadow-[1rem_0_0_rgb(251,191,36),2rem_0_0_rgb(16,185,129)] focus-within:shadow-[0_20px_48px_rgba(15,23,42,0.16),0_0_0_2px_rgba(56,189,248,0.18)] dark:border-slate-950/70 dark:bg-[#1F232B] dark:shadow-[0_18px_44px_rgba(0,0,0,0.35)]">
            <MarkdownCodeEditor
              className="rfm-source-editor min-h-0 flex-1 pt-10 text-slate-200 [--cm-selection-bg:rgb(30_58_138_/_0.45)]"
              testId="rfm-source-editor"
              value={source}
              onChange={handleSourceChange}
            />
          </div>
        </div>

        <div
          className="hidden items-start justify-center pt-3 text-stone-400 dark:text-stone-500 lg:flex"
          data-testid="rfm-format-demo-arrow"
        >
          <ArrowRight className="size-5" aria-hidden="true" />
        </div>

        <div
          className="min-w-0 overflow-visible rounded-lg border-0 bg-transparent shadow-none"
          data-testid="rfm-result-pane"
        >
          <div className="flex h-10 items-center border-b border-transparent px-4 text-xs font-semibold tracking-[0.14em] text-stone-500 uppercase dark:text-slate-400">
            <span>Result</span>
          </div>
          <div className="rfm-result-editor" data-testid="rfm-result-editor">
            <PageCard
              page={page}
              selected
              layout="embedded-demo"
              backend={demoBackend}
              interactionMode="editing"
              onSave={async () => {}}
              onLocalContentChange={handleResultChange}
              saveBlocked
            />
          </div>
        </div>
      </div>
    </section>
  );
}
