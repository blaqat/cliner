# Thread worktree integration

Step 8 adds thread isolation to the existing VS Code worktree feature. Git creation uses `utils/git-worktree.createWorktree`, including `.worktreeinclude` copying. The existing create, delete, and merge interfaces now render inline.

## Composer integration for step 5

`webview-ui/src/components/worktrees/WorktreeToggle.tsx` exports `WorktreeToggle`. Mount `<WorktreeToggle />` inside the where pill's content. It needs no props and does not render an overlay.

`webview-ui/src/components/worktrees/useWorktree.ts` exports `useWorktree(threadId?: string)`:

```tsx
const { enabled, availability, state, setEnabled, busy, error, refresh } = useWorktree()

await TaskServiceClient.newTask(NewTaskRequest.create({
	text,
	runInWorktree: enabled,
}))
```

`enabled` is shared across hook instances in the webview. It starts false and resets when the current thread changes. `availability` contains `mode`, `available`, `reason`, `workspaceOff`, and `hasMmrc`. Existing threads expose their mapping through `state.mapping`; isolation is chosen only when starting a thread.

Pass `runInWorktree` explicitly when sending. If the field is omitted, the thread starts in the user workspace. This branch does not edit `ChatTextArea.tsx` or the composer row.

## Host diff API for step 9 and checkpoints

```ts
Controller.getThreadWorktreeDiffs(threadId: string): Promise<ThreadModuleDiff[]>
```

The webview calls the same operation through:

```ts
threadWorktreeAction("diffs", threadId): Promise<WorktreeActionResult>
// result.diffs: ThreadModuleDiff[]
```

Each result contains `module`, `workspacePath`, `worktreePath`, `base`, `tree`, `patch`, and `paths`. `base` is the commit captured when isolation began. `tree` is the current snapshot tree. `patch` is a binary-capable unified Git patch relative to the module root. `paths` are display paths prefixed with the module name, such as `api/src/server.ts`. Git mode uses an empty module name for the root repository. Descendant submodules produce their own entries, with their relative path as the module name. Their `workspacePath` and `worktreePath` point at the descendant repository. Descendant entries also carry `head` and `baseHead` for gitlink changes.

Diffs include committed, staged, unstaged, and untracked files. Ignored files stay ignored. Snapshotting uses a temporary index and leaves the real index unchanged. Apply patches inside their module root; use `paths` for walkthrough labels. These are whole-thread diffs. Turn-specific checkpoint snapshots remain the caller's responsibility.

## Settings and persisted state

`WorktreeService.threadWorktreeAction` accepts `action`, `threadId`, `json`, and `confirmed`, and returns JSON typed by `shared/thread-worktrees.ts`. Actions are `state`, `configure`, `workspaceOff`, `diffs`, `open`, `bring`, `undo`, `takeOver`, and `remove`.

The extension's global storage contains `thread-worktrees/settings.json`, one hashed JSON record per thread under `thread-worktrees/threads/`, and saved bring-ins under `thread-worktrees/patches/<bring-id>/`. Each bring-in contains a manifest and one patch per changed module. Removing an isolate retains those files and its Git branch. A record under `removed/threads/` stores the original workspace and removal time for other windows.

Settings contain `mode: "off" | "git" | "mm"`, `mmPath`, and `nodePath`. The nearest `.mm.json` or `.mmrc` found by searching upward enables mm automatically. `.mm.json` wins when both files exist in the same directory. Module paths and isolate locations resolve from that configuration directory. The per-workspace off switch is `worktreeToggles.disabled` in workspace state. mm mode falls back to Git in workspaces without either configuration file.

A thread record contains its original workspace, isolate cwd, branch, module paths, base commits, last transferred diff, and bring-in journal. Creation records the mapping before calling Git or mm so a partial failure remains visible. Records use separate files so creating a thread in another window cannot replace the whole mapping collection.

## Runtime behavior

`SdkTaskStartCoordinator.prepareWorkspace` creates the isolate after provider validation and before starting the SDK session. Both `config.cwd` and `config.workspaceRoot` point at the isolate, and history stores that cwd. The SDK receives this cwd for file edits, search, and terminal tools. File reads, edit previews, and approval labels resolve paths against the calling session. Auto-approved previews use the executor cwd directly. Explicit file mentions use the thread's module roots. Resume validates the saved mapping and refuses a missing isolate instead of editing the original workspace.

mm runs as `nodePath mmPath isolate <branch>` and `nodePath mmPath free <branch>`, with argument arrays and the original workspace as cwd. The manager verifies each module afterward, including that configured roots share the source repository and remain on the thread branch. Descendants may have detached HEADs. Removal refuses to run `mm free` if the configured module list has changed. Legacy newline lists, JSON module arrays, and JSON module objects with `path` are supported. Duplicate module basenames and paths outside the workspace are rejected because mm maps modules by basename. Selecting both a repository and its descendants is also rejected, because those isolates would copy competing snapshots into the same original repository.

Bring here checks all module patches before applying them and journals each applied module. Later bring-ins contain only changes since the last transfer. Undo first tries a reverse patch. On overlap, it runs `git apply -3 -R --index` with a temporary index that represents the current files. Conflicts leave markers in the workspace and return module-prefixed paths for inline display. The user's real index stays unchanged during file-only copies and undo conflicts. A copied gitlink moves the destination submodule checkout to its recorded commit. That move requires clean destination files and resets its clean index to the copied commit. Undo restores its former HEAD and branch, and preserves any staging added after the copy.

Take over requires a clean workspace. It carries each repository's staged, unstaged and untracked changes in a separate stash, including descendants whose object databases are independent. It detaches configured isolate roots before checking out their branch in the original workspace, and checks out descendant commits detached. Failures restore completed steps. The leftover snapshot includes every repository's working tree, index and HEAD, so later edits and commits still trigger a removal warning. Bring fingerprints the exact captured trees it applies. Removal warns when the isolate contains a diff that has not been transferred or a staged version that differs from its working files. Running threads cannot be brought in, undone, taken over, or removed. Mutations use an atomic directory lock in global storage across extension hosts, with a PID, timestamp, heartbeat, and stale-owner recovery. Session startup and every turn acquire a shared per-thread lease before reading the mapping. The lease refreshes while running or queued, and releases when idle or stopped; destructive actions check it under the storage lock. Cleanup lists settled or completed threads and requires an explicit selection. No worktree is removed automatically. Remove retires the local idle session. Other windows rebuild retained sessions before their next turn. That turn runs in the original workspace and includes a short notice for the agent. The inline removal result also states where the next turn runs.

## Verification

The manager tests create temporary Git repositories and a temporary two-module `.mmrc` project. The mm cases execute `/Users/blaqat/dev/tools/scripts/mm.js` only inside those temporary projects. The nested-submodule fixtures cover relative URLs, staged and unstaged versions, untracked files, committed gitlink changes, ignore settings, independent object databases, mm try/restore, and configured modules that are themselves submodules. No tests use real user projects or real user settings.

Focused SDK tests cover the cwd override and per-session file reads. Webview tests cover draft defaults, availability, the breadcrumb badge, inline remove warnings, conflict paths, settings, and selected cleanup. No real VS Code window was used for manual verification.

Submodule additions, removals and path changes are currently blocked by an explicit error. Unreadable or missing descendants require confirmation before removal. Git-mode creation can clone initialized descendants or their local Git caches; a descendant with neither must first be initialized in the original workspace.
