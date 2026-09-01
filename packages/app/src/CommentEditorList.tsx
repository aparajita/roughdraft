import { Bot, MoreHorizontal, User } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Button } from "./components/ui/button";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "./components/ui/menu";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";
import { renderMarkdownToHtml } from "./markdown";
import type { ReviewComment } from "./review";

interface CommentEditorListProps {
  comments: ReviewComment[];
  onUpdateComment: (commentId: string, nextContent: string) => void;
  onDeleteComment: (commentId: string) => void;
  onDeleteThread: (rootCommentId: string) => void;
  testId?: string;
}

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;
/** The mean Gregorian month and year, so that "3 months ago" does not drift. */
const SECONDS_PER_MONTH = 2_629_746;
const SECONDS_PER_YEAR = 12 * SECONDS_PER_MONTH;

/**
 * Largest unit first: the first unit the elapsed time reaches is the one the
 * relative time is expressed in. Anything below a minute reads as "now".
 */
const RELATIVE_TIME_UNITS: {
  unit: Intl.RelativeTimeFormatUnit;
  seconds: number;
}[] = [
  { unit: "year", seconds: SECONDS_PER_YEAR },
  { unit: "month", seconds: SECONDS_PER_MONTH },
  { unit: "week", seconds: SECONDS_PER_WEEK },
  { unit: "day", seconds: SECONDS_PER_DAY },
  { unit: "hour", seconds: SECONDS_PER_HOUR },
  { unit: "minute", seconds: SECONDS_PER_MINUTE },
];

// Both formatters are created once: constructing an Intl formatter is far more
// expensive than formatting with it, and a comment list re-renders constantly.
const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});
const absoluteTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The two readings of a comment's timestamp: `relative` is what the row shows,
 * `absolute` is the local time its `title` carries. An unparseable timestamp is
 * shown as written rather than as "Invalid Date".
 */
function formatCommentTime(
  at: string,
  now: Date,
): { relative: string; absolute: string } {
  const parsed = new Date(at);

  if (Number.isNaN(parsed.getTime())) {
    return { relative: at, absolute: at };
  }

  const elapsedSeconds =
    (parsed.getTime() - now.getTime()) / MILLISECONDS_PER_SECOND;
  const magnitude = Math.abs(elapsedSeconds);
  const unit = RELATIVE_TIME_UNITS.find(
    (candidate) => magnitude >= candidate.seconds,
  );

  return {
    relative: unit
      ? relativeTimeFormat.format(
          Math.round(elapsedSeconds / unit.seconds),
          unit.unit,
        )
      : relativeTimeFormat.format(0, "second"),
    absolute: absoluteTimeFormat.format(parsed),
  };
}

function compareComments(left: ReviewComment, right: ReviewComment) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }

  if (left.id === right.id) return 0;

  return left.id < right.id ? -1 : 1;
}

function authorLabelOf(comment: ReviewComment) {
  if (comment.authorType === "ai") return "AI";

  const authorId = comment.authorId?.trim();

  return authorId && authorId.toLowerCase() !== "user" ? authorId : "Me";
}

/**
 * The comments of one review entry, flat and in the order they were written.
 * The caller decides which comments belong together; this list neither groups
 * nor nests them, and a reply is a sibling of the comment it answers.
 */
export function CommentEditorList({
  comments,
  onUpdateComment,
  onDeleteComment,
  onDeleteThread,
  testId,
}: CommentEditorListProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingCommentIds, setEditingCommentIds] = useState<string[]>([]);
  const orderedComments = useMemo(
    () => [...comments].sort(compareComments),
    [comments],
  );

  useEffect(() => {
    const validCommentIds = new Set(comments.map((comment) => comment.id));

    setDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([commentId]) =>
          validCommentIds.has(commentId),
        ),
      ),
    );
    setEditingCommentIds((current) =>
      current.filter((commentId) => validCommentIds.has(commentId)),
    );
  }, [comments]);

  if (orderedComments.length === 0) return null;

  const now = new Date();

  const startEditingComment = (comment: ReviewComment) => {
    setDrafts((current) => ({
      ...current,
      [comment.id]: current[comment.id] ?? comment.content,
    }));
    setEditingCommentIds((current) =>
      current.includes(comment.id) ? current : [...current, comment.id],
    );
  };

  const stopEditingComment = (commentId: string) => {
    setDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[commentId];
      return nextDrafts;
    });
    setEditingCommentIds((current) =>
      current.filter((currentCommentId) => currentCommentId !== commentId),
    );
  };

  const submitEditingComment = (comment: ReviewComment) => {
    const nextContent = (drafts[comment.id] ?? comment.content).trim();

    // An emptied body is not a deletion: Delete is its own action, so an empty
    // draft simply has nothing to save and the editor stays open.
    if (nextContent.length === 0) return;

    if (nextContent !== comment.content) {
      onUpdateComment(comment.id, nextContent);
    }

    stopEditingComment(comment.id);
  };

  return (
    <div
      data-testid={testId}
      data-comment-thread-container="true"
      className="space-y-3"
    >
      {orderedComments.map((comment) => (
        <CommentRow
          key={comment.id}
          comment={comment}
          now={now}
          isEditing={editingCommentIds.includes(comment.id)}
          draftContent={drafts[comment.id] ?? comment.content}
          onChangeDraft={(nextContent) => {
            setDrafts((current) => ({
              ...current,
              [comment.id]: nextContent,
            }));
          }}
          onStartEditing={() => startEditingComment(comment)}
          onSubmitEditing={() => submitEditingComment(comment)}
          onCancelEditing={() => stopEditingComment(comment.id)}
          onDeleteComment={() => onDeleteComment(comment.id)}
          onDeleteThread={() => onDeleteThread(comment.id)}
        />
      ))}
    </div>
  );
}

interface CommentRowProps {
  comment: ReviewComment;
  now: Date;
  isEditing: boolean;
  draftContent: string;
  onChangeDraft: (nextContent: string) => void;
  onStartEditing: () => void;
  onSubmitEditing: () => void;
  onCancelEditing: () => void;
  onDeleteComment: () => void;
  onDeleteThread: () => void;
}

function CommentRow({
  comment,
  now,
  isEditing,
  draftContent,
  onChangeDraft,
  onStartEditing,
  onSubmitEditing,
  onCancelEditing,
  onDeleteComment,
  onDeleteThread,
}: CommentRowProps) {
  const isRoot = !comment.parentCommentId;
  const isAiAuthor = comment.authorType === "ai";
  const AuthorIcon = isAiAuthor ? Bot : User;
  const authorLabel = authorLabelOf(comment);
  const { relative, absolute } = formatCommentTime(comment.createdAt, now);
  const bodyHtml = useMemo(
    () => renderMarkdownToHtml(comment.content),
    [comment.content],
  );

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "enter"
    ) {
      event.preventDefault();
      event.stopPropagation();
      onSubmitEditing();
      return;
    }

    if (event.key !== "Escape") return;

    event.preventDefault();
    event.stopPropagation();
    onCancelEditing();
  };

  return (
    <div
      data-testid={`comment-row-${comment.id}`}
      data-comment-thread-root-id={isRoot ? comment.id : undefined}
      className="min-w-0"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <div
          aria-hidden="true"
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border shadow-sm",
            isAiAuthor
              ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-400"
              : "border-stone-300 bg-stone-300 text-stone-700 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300",
          )}
        >
          <AuthorIcon className="size-2.5 shrink-0" />
        </div>
        <div className="min-w-0 truncate text-base font-semibold text-slate-900 dark:text-slate-100">
          {authorLabel}
        </div>
        <div
          className="shrink-0 text-base text-stone-500 dark:text-slate-400"
          title={absolute}
        >
          {relative}
        </div>
        <Menu>
          <MenuTrigger
            aria-label="Comment actions"
            data-testid={`comment-row-${comment.id}-menu`}
            className="ml-auto size-6"
          >
            <MoreHorizontal className="size-3.5" />
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              className="text-base"
              data-testid={`comment-row-${comment.id}-action-edit`}
              onClick={onStartEditing}
            >
              Edit
            </MenuItem>
            <MenuItem
              data-testid={`comment-row-${comment.id}-action-delete`}
              className="text-base text-rose-700 dark:text-rose-400 data-[highlighted]:bg-rose-100 dark:data-[highlighted]:bg-rose-900/40 data-[highlighted]:text-rose-700 dark:data-[highlighted]:text-rose-400"
              onClick={onDeleteComment}
            >
              Delete
            </MenuItem>
            {isRoot ? (
              <>
                <MenuSeparator />
                <MenuItem
                  data-testid={`comment-row-${comment.id}-action-delete-thread`}
                  className="text-base text-rose-700 dark:text-rose-400 data-[highlighted]:bg-rose-100 dark:data-[highlighted]:bg-rose-900/40 data-[highlighted]:text-rose-700 dark:data-[highlighted]:text-rose-400"
                  onClick={onDeleteThread}
                >
                  Delete thread
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      </div>
      {isEditing ? (
        <>
          <Textarea
            autoFocus
            data-testid={`comment-row-${comment.id}-editor`}
            value={draftContent}
            rows={1}
            className="mt-1.5 min-h-12 px-2.5 py-2 text-base leading-5 md:text-base md:leading-5"
            onKeyDown={handleEditorKeyDown}
            onChange={(event) => {
              onChangeDraft(event.target.value);
            }}
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-base"
              onClick={onCancelEditing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="text-base"
              data-testid={`comment-row-${comment.id}-action-save`}
              disabled={draftContent.trim().length === 0}
              onClick={onSubmitEditing}
            >
              Save
            </Button>
          </div>
        </>
      ) : (
        <div
          className="tiptap prose prose-stone dark:prose-slate dark:prose-invert max-w-none mt-1 min-h-0 prose-code:before:content-none prose-code:after:content-none"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a comment body is Markdown and renders through the document's own renderer.
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
    </div>
  );
}
