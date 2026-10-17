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

Each result contains `module`, `workspacePath`, `worktreePath`, `base`, `tree`, `patch`, and `paths`. `base` is the commit captured when isolation began. `tree` is the current snapshot tree. `patch` is a binary-capable unified Git patch relative to the module root. `paths` are display paths prefixed with the module name, such as `api/src/server.ts`. Git mode uses an empty module name and ordinary repository paths.

Diffs include committed, staged, unstaged, and untracked files. Ignored files stay ignored. Snapshotting uses a temporary index and leaves the real index unchanged. Apply patches inside their module root; use `paths` for walkthrough labels. These are whole-thread diffs. Turn-specific checkpoint snapshots remain the caller's responsibility.

## Settings and persisted state

`WorktreeService.threadWorktreeAction` accepts `action`, `threadId`, `json`, and `confirmed`, and returns JSON typed by `shared/thread-worktrees.ts`. Actions are `state`, `configure`, `workspaceOff`, `diffs`, `open`, `bring`, `undo`, `takeOver`, and `remove`.

The extension's global storage contains `thread-worktrees/settings.json`, one hashed JSON record per thread under `thread-worktrees/threads/`, and saved bring-ins under `thread-worktrees/patches/<bring-id>/`. Each bring-in contains a manifest and one patch per changed module. Removing an isolate retains those files and its Git branch.

Settings contain `mode: "off" | "git" | "mm"`, `mmPath`, and `nodePath`. A `.mmrc` at the workspace root enables mm automatically. The per-workspace off switch is `worktreeToggles.disabled` in workspace state. mm mode falls back to Git in workspaces without `.mmrc`.

A thread record contains its original workspace, isolate cwd, branch, module paths, base commits, last transferred diff, and bring-in journal. Creation records the mapping before calling Git or mm so a partial failure remains visible. Records use separate files so creating a thread in another window cannot replace the whole mapping collection.

## Runtime behavior

`SdkTaskStartCoordinator.prepareWorkspace` creates the isolate after provider validation and before starting the SDK session. Both `config.cwd` and `config.workspaceRoot` point at the isolate, and history stores that cwd. The SDK receives this cwd for file edits, search, and terminal tools. The file-read override uses the calling session. Explicit file mentions use the thread's module roots. Resume validates the saved mapping and refuses a missing isolate instead of editing the original workspace.

mm runs as `nodePath mmPath isolate <branch>` and `nodePath mmPath free <branch>`, with argument arrays and the original workspace as cwd. Both commands can return exit status zero after a module failure, so the manager verifies each module afterward. Legacy newline lists, JSON module arrays, and JSON module objects with `path` are supported. Duplicate module basenames and paths outside the workspace are rejected because mm maps modules by basename.

Bring here checks all module patches before applying them and journals each applied module. Later bring-ins contain only changes since the last transfer. Undo first tries a reverse patch. On overlap, it runs `git apply -3 -R --index` with a temporary index that represents the current files. Conflicts leave markers in the workspace and return module-prefixed paths for inline display. The user's real index stays unchanged.

Take over requires clean workspace and isolate files. It detaches the isolate so Git can check out its branch in the original workspace. Removal warns when the isolate contains a diff that has not been transferred. Running threads cannot be brought in, taken over, or removed. Cleanup lists settled or completed threads and requires an explicit selection. No worktree is removed automatically.

## Verification

The manager tests create temporary Git repositories and a temporary two-module `.mmrc` project. The mm cases execute `/Users/blaqat/dev/tools/scripts/mm.js` only inside those temporary projects. No tests use real user projects or real user settings.

Focused SDK tests cover the cwd override and per-session file reads. Webview tests cover draft defaults, availability, the breadcrumb badge, inline remove warnings, conflict paths, settings, and selected cleanup. No real VS Code window was used for manual verification.
