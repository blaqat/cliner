# Walkthrough backend contract

`src/shared/Walkthrough.ts` defines the JSON contract shared with the webview. The page is `webview-ui/src/components/walkthrough/WalkthroughView.tsx`; review marks and notes persist in webview localStorage per task, scope and fingerprint (`reviewState.ts`). Thread actions open it with `navigateToWalkthrough()`. Navigation history records `{ kind: "walkthrough", id: taskId }`.

```ts
type WalkthroughScope = "thread" | "last_turn" | "git" | "authored"

interface ChangeWalkthrough {
	version: 1
	taskId: string
	scope: WalkthroughScope
	fingerprint: string
	source: "fallback" | "generated" | "authored"
	title: string
	focus: string
	chapters: Array<{
		id: string
		title: string
		stops: WalkthroughStop[]
	}>
	support: WalkthroughStop[]
	hunks: Array<{
		id: string
		fingerprint: string
		fileId: string
		path: string
		header: string
		patch: string
		oldStart: number
		newStart: number
		turnId?: string
		synthetic?: boolean
	}>
	warnings: string[]
	profileId?: string
	cacheHit?: boolean
}

interface WalkthroughStop {
	id: string
	title: string
	prose: string
	detail?: string
	hunkIds: string[]
	turnId?: string
}
```

In the free (from-turns) layout, `prose` is a few lines of the turn's final message (the completion summary, else the last assistant text). `detail` holds the turn's whole narration when `prose` leaves something out; the webview shows it behind "Show more".

Hunk aliases are deterministic `h1`, `h2`, … for the current collection. A content fingerprint identifies each real patch. Refresh can reassign aliases, so retain notes and review state only while `fingerprint` remains unchanged. Render hunk paths and patches from `hunks`, never from model output. `fileId` is an opaque host-resolved file identifier. Absolute paths and complete file contents stay on the host.

All five RPCs belong to `TaskService`. Each accepts `StringRequest { value: JSON.stringify(request) }`. The document-returning RPCs return `String { value: JSON.stringify(walkthrough) }`. The others return `Empty`.

- `getChangeWalkthrough`: `{ taskId, scope }`. Free collection only.
- `generateChangeWalkthrough`: `{ taskId, scope, profileId, regenerate?: boolean }`. One provider request on a cache miss. `regenerate: true` bypasses the cache and includes the previous document's prose without IDs.
- `openWalkthroughDiff`: `{ taskId, scope, fingerprint, fileId }`. Opens the native VS Code diff editor. `hunkId` can replace `fileId`.
- `revertWalkthroughChange`: `{ taskId, scope, fingerprint, fileId, confirmed: true }`. Include `hunkId` to revert only that hunk. Returns the refreshed document. The page owns inline confirmation.
- `sendWalkthroughNotes`: `{ taskId, scope, fingerprint, stopNotes: Record<stopId, string>, overallNote?: string }`. Builds one message from host-owned stops and bounded patch quotes, then uses `task.handleWebviewAskResponse("messageResponse", ...)`, the normal webview send path. On success, return to the thread.

The thread must still be focused. Unknown IDs, stale fingerprints, changed files, and unconfirmed reverts fail without writing. Reverts apply exact reverse patches and preserve other hunks. Binary files are reviewable as synthetic hunks but cannot be reverted here. Files over 2 MiB and symlink files are reported as unavailable. Collection continues through the remaining files.

The free layout groups surviving changes by editing turn. A net hunk that combines several turns belongs to the turn with the most matching changed lines, with the latest turn breaking ties. Prose comes from that turn's assistant text. Whole git diff groups known thread edits by turn and uses one stop per file for changes without turn evidence. Both paths use the same document shape.

Existing SDK checkpoints supply before contents at user-turn boundaries, including stash third-parent contents for untracked files. Deduplicated checkpoints use the nearest preceding snapshot. After compaction, older changes recover from the first checkpoint under an explicit Earlier edits group when their original prose is unavailable. New `editor` and `apply_patch` operations also append actual disk before/after contents to `tasks/<taskId>/walkthrough-edits.jsonl`. A missing tool call in the live transcript excludes its journal entry after history truncation. Collection uses the net change from the earliest relevant before content to the current file. It reports external edits after the recorded write. Checkpoints still cover only the primary git root; older multi-root threads and command-only edits outside that root need whole git diff.

Generate has no agent loop, retry, or repair call. It requests one `submit_walkthrough` tool, drops unknown and duplicate aliases, and places omissions in `support`. Cache files live in `tasks/<taskId>/walkthrough-cache/<hash>.json`. The hash includes live diff fingerprints, profile/model identity and options, context, prompt, schema, and version. Cache identity excludes the previous walkthrough, so explicit regeneration replaces that diff's result.

Generate runs on the Background text model from Settings > Models, or the pick made beside the Generate button for that one call. Nothing is remembered.

Prompt excerpts use 60,000 characters total or 35,000 above 32 files, with per-hunk caps of 8,000, 2,500, or 700. Context is capped at 16,000 characters. Timeouts scale from 90 seconds to five minutes. The manual eval runner is documented in `evals/walkthrough/README.md`.


## Agent-authored walkthroughs

`present_walkthrough` accepts `AuthoredWalkthroughInput` from `src/shared/Walkthrough.ts`:

```ts
{
  title: string
  focus?: string
  origin?: { label: string; url?: string }
  chapters: Array<{
    title: string
    stops: Array<{
      title: string
      prose: string
      hunks: Array<{ path: string; patch: string }>
    }>
  }>
}
```

`authored-tool.ts` defines the tool. `sdk/vscode-runtime-builder.ts` registers it with the other extension-host tools. `sdk/vscode-session-host.ts` auto-approves it in Ask and Act. It has no `subagentAccess` metadata, so session-spawned subagents do not receive it. The tool description asks for conceptual chapters, 2–6 word stop titles, short prose with inline code only, and diffs copied verbatim from the source.

The host validates input before writing. Limits are 1–8 chapters, 1–60 total stops, 400 parsed hunks, and 300,000 total patch characters. Stops may contain no hunks. Strings have additional bounds in `authored.ts`; origin URLs accept HTTP and HTTPS only. Each patch accepts one unified `@@` hunk or one full file diff with multiple hunks. The parser recomputes each hunk's old/new line counts from its body (and the start lines when missing or garbled, falling back to the other side or 1), keeps the hunk, rewrites the header, and records ``Fixed the line counts in a hunk header in `<path>`: `<old>` → `<new>` `` in the document's `warnings`. Blank context lines that lost their leading space are restored. Correct hunks are preserved verbatim; CRLF is normalized to LF and a final newline is added. Only unparseable patches (no hunk lines, or lines that are not context, `+` or `-`) produce an error the agent can correct. File headers are discarded; the supplied `path` identifies the file. The host never resolves these paths against the local workspace.

Normalized documents use `scope: "authored"`, `source: "authored"`, `authoredId`, and optional `origin`. Hunks use `external: true`, sequential `h1` aliases, content fingerprints, and a stable file ID hashed from the supplied path. The document fingerprint covers title, focus, origin, chapters, and hunks.

Each successful presentation creates a new UUID and writes the full document to `tasks/<taskId>/walkthroughs/<authoredId>.json` under extension global storage. Re-presenting the same title and origin adds a separate document, preserving earlier cards and notes. The SDK persists the tool result, a JSON string with `{ walkthroughReady: WalkthroughReadyMessage, message: string }`. `sdk/message-translator.ts` emits its `walkthrough_ready` say row with the ready payload as JSON text. History reconstruction uses the same translator branch, so the row survives reload and reopen. Failed calls emit an error instead of a ready card.

Authored RPC payloads use the existing `StringRequest` JSON envelope:

- `getChangeWalkthrough`: `{ taskId, scope: "authored", authoredId }`. Returns the stored document without git collection or a model request.
- `sendWalkthroughNotes`: `{ taskId, scope: "authored", authoredId, fingerprint, stopNotes, overallNote? }`. Loads the stored document, checks its fingerprint, and quotes its stop titles and bounded hunk excerpts. The message includes the origin label and URL when supplied, then follows the normal thread send path.
- `openWalkthroughDiff`, `revertWalkthroughChange`, and `generateChangeWalkthrough` reject `scope: "authored"` with explicit errors. Authored hunks describe external changes and cannot operate on local files.

Get and send require the requested thread to remain focused. Unknown document IDs and stale fingerprints fail. No shared-type, protobuf, or setting changes are required.

The tool result tells the model the walkthrough is shown and to finish with one short sentence. The tool is declared with `lifecycle.emptyResponseCompletes`, so if the model then returns an empty response, the SDK agent runtime completes the run instead of failing with "Model returned empty response". That applies only when the conversation ends directly with a successful result from such a tool.

## Cline's review notes

Review notes are separate from user notes and explanatory `why` annotations. `present_walkthrough` accepts optional `review: { summary?, notes }` only when the user asks for review or improvement notes. Each note has `kind` (`risk`, `suggestion`, `question`, `nice`), optional `severity: "high"`, `title`, `text`, and optional `stop` (exact title), `path`, and `lines` (exact patch text). High severity is reserved for real problems. No notes is a valid answer.

`review.ts` validates both authored and generated reviews. It resolves text to host-owned hunk body indexes and stop IDs. Missing line anchors fall back to the known stop; otherwise the note applies to the whole change. IDs hash the normalized note, so the same note keeps its ID. Notes are ordered high first, then in source order. Duplicate notes are removed; at most three notes per stop and ten total survive. Authored document fingerprints include review content. Ready cards carry `reviewCount` and `reviewHighCount` when review exists, including zero counts for an empty review. The existing SDK translator preserves those fields in live and reconstructed cards.

`generateChangeWalkthrough` accepts `reviewNotes?: boolean`. Only `true` adds a separate review instruction and schema to the existing single Generate call. Walkthrough prose and why notes still must not invent bugs, tests, validation or risks. Review instructions permit only real concerns supported by the supplied diff or context and forbid speculative problems. The review flag participates in the disk cache key. Cached reviews retain their IDs and anchors.

`sendWalkthroughNotes` accepts `reviewResponses: Record<noteId, { fix?, reply?, dismissed? }>`. The webview persists these alongside stop, line and overall notes with the same task/scope/fingerprint lifecycle. The backend resolves response IDs against the current host-owned document. Dismissed and untouched notes are omitted. A selected note is grouped under its stop, quoted with its title, anchor and text, then followed by the user's actions:

```text
Review notes for the change walkthrough:

> Stop: Validate input
> Cline's risk: Missing guard
> a.ts:1-2
> The value is used without a guard.

Please fix this.

Reply: Keep the current API.
```

`Please fix this.` appears only for Fix, and `Reply:` only for a nonempty reply. Stop-only notes quote `Stop: <title>` as their anchor; whole-change notes quote `Whole change`. Existing user notes and the overall note remain in the same message. Review responses never trigger another provider request.
