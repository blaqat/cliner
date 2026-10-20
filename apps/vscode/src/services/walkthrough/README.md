# Walkthrough backend contract

`src/shared/Walkthrough.ts` defines the JSON contract shared with the webview. The page is `webview-ui/src/components/walkthrough/WalkthroughView.tsx`; review marks and notes persist in webview localStorage per task, scope and fingerprint (`reviewState.ts`). Thread actions open it with `navigateToWalkthrough()`. Navigation history records `{ kind: "walkthrough", id: taskId }`.

```ts
type WalkthroughScope = "thread" | "last_turn" | "git"

interface ChangeWalkthrough {
	version: 1
	taskId: string
	scope: WalkthroughScope
	fingerprint: string
	source: "fallback" | "generated"
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

All five RPCs belong to `TaskService`. Each accepts `StringRequest { value: JSON.stringify(request) }`. The three document-returning RPCs return `String { value: JSON.stringify(walkthrough) }`. The others return `Empty`.

- `getChangeWalkthrough`: `{ taskId, scope }`. Free collection only.
- `generateChangeWalkthrough`: `{ taskId, scope, profileId, regenerate?: boolean }`. One provider request on a cache miss. `regenerate: true` bypasses the cache and includes the previous document's prose without IDs.
- `openWalkthroughDiff`: `{ taskId, scope, fingerprint, fileId }`. Opens the native VS Code diff editor. `hunkId` can replace `fileId`.
- `revertWalkthroughChange`: `{ taskId, scope, fingerprint, fileId, confirmed: true }`. Include `hunkId` to revert only that hunk. Returns the refreshed document. The page owns inline confirmation.
- `sendWalkthroughNotes`: `{ taskId, scope, fingerprint, stopNotes: Record<stopId, string>, overallNote?: string }`. Builds one message from host-owned stops and bounded patch quotes, then uses `task.handleWebviewAskResponse("messageResponse", ...)`, the normal webview send path. On success, return to the thread.

The thread must still be focused. Unknown IDs, stale fingerprints, changed files, and unconfirmed reverts fail without writing. Reverts apply exact reverse patches and preserve other hunks. Binary files are reviewable as synthetic hunks but cannot be reverted here. Files over 2 MiB and symlink files are reported as unavailable. Collection continues through the remaining files.

The free layout groups surviving changes by editing turn. A net hunk that combines several turns belongs to the turn with the most matching changed lines, with the latest turn breaking ties. Prose comes from that turn's assistant text. Whole git diff groups known thread edits by turn and uses one stop per file for changes without turn evidence. Both paths use the same document shape.

Existing SDK checkpoints supply before contents at user-turn boundaries, including stash third-parent contents for untracked files. Deduplicated checkpoints use the nearest preceding snapshot. After compaction, older changes recover from the first checkpoint under an explicit Earlier edits group when their original prose is unavailable. New `editor` and `apply_patch` operations also append actual disk before/after contents to `tasks/<taskId>/walkthrough-edits.jsonl`. A missing tool call in the live transcript excludes its journal entry after history truncation. Collection uses the net change from the earliest relevant before content to the current file. It reports external edits after the recorded write. Checkpoints still cover only the primary git root; older multi-root threads and command-only edits outside that root need whole git diff.

Generate has no agent loop, retry, or repair call. It requests one `submit_walkthrough` tool, drops unknown and duplicate aliases, and places omissions in `support`. Cache files live in `tasks/<taskId>/walkthrough-cache/<hash>.json`. The hash includes live diff fingerprints, profile/model identity and options, context, prompt, schema, and version. Cache identity excludes the previous walkthrough, so explicit regeneration replaces that diff's result.

`readRememberedWalkthroughProfileId(controller)` in `service.ts` is the single Step 6 integration point. It currently returns `undefined`. The page passes a selected profile ID. No new setting is stored. Explicit profiles keep their selected model for large diffs, matching Codiff's treatment of explicit model selections.

Prompt excerpts use 60,000 characters total or 35,000 above 32 files, with per-hunk caps of 8,000, 2,500, or 700. Context is capped at 16,000 characters. Timeouts scale from 90 seconds to five minutes. The manual eval runner is documented in `evals/walkthrough/README.md`.
