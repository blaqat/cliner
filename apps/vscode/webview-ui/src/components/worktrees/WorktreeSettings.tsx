import type { ThreadWorktreeSettings, WorktreeMode, WorktreeState } from "@shared/thread-worktrees"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { settingsRowElementId } from "../settings/settingsTargets"
import { threadWorktreeAction, useWorktree, worktreeErrorText } from "./useWorktree"

/** The controls a link into Worktrees settings can land on. */
export const WORKTREE_CONTROLS = {
	mode: "worktrees-mode",
	useMm: "worktrees-use-mm",
	workspace: "worktrees-workspace-switch",
	mm: "worktrees-mm-path",
	node: "worktrees-node-path",
	folder: "worktrees-folder-fix",
} as const

/** The control that fixes what's in the way now; the Mode when nothing is, or nothing more specific helps. */
function fixControl(state: WorktreeState): string {
	const { availability } = state
	switch (availability.available ? undefined : availability.fix) {
		case "mode":
			return document.getElementById(WORKTREE_CONTROLS.useMm) ? WORKTREE_CONTROLS.useMm : WORKTREE_CONTROLS.mode
		case "workspace":
			return WORKTREE_CONTROLS.workspace
		case "mm":
			return /node path:/i.test(availability.reason ?? "") ? WORKTREE_CONTROLS.node : WORKTREE_CONTROLS.mm
		case "repository":
		case "commit":
			return WORKTREE_CONTROLS.folder
		default:
			return WORKTREE_CONTROLS.mode
	}
}

/** Set by the Settings shell while it scrolls to and highlights a row that a link pointed at. */
const TARGET_HIGHLIGHT_CLASS = "settings-target-highlight"

const MODE_DESCRIPTIONS: Record<WorktreeMode, string> = {
	off: "New threads run in your workspace.",
	git: "A new thread can run in its own Git worktree and branch.",
	mm: "A new thread can run in its own mm worktrees, one per module. Folders without mm config use Git.",
}

/** One line of feedback under a control: a check when it's fine, a warning when it needs a fix. */
function Feedback({ ok, children, testId }: { ok?: boolean; children: ReactNode; testId?: string }) {
	return (
		<p className="m-0 flex items-start gap-1.5 text-xs text-description wrap-anywhere" data-testid={testId} role="status">
			<span
				aria-hidden
				className={cn(
					"codicon mt-px shrink-0 text-[12px]!",
					ok ? "codicon-check text-(--vscode-charts-green)" : "codicon-warning text-warning",
				)}
			/>
			<span className="min-w-0">{children}</span>
		</p>
	)
}

/** A path box that saves when it loses focus or on Enter; Escape puts back the saved value. */
function PathField({
	id,
	label,
	placeholder,
	saved,
	onSave,
	children,
}: {
	id: string
	label: string
	placeholder: string
	saved: string
	onSave: (value: string) => Promise<void>
	children?: ReactNode
}) {
	const [draft, setDraft] = useState<string>()
	// The latest text in the box, for after a save: typing goes on while one is out.
	const latest = useRef(draft)
	latest.current = draft
	const commit = async () => {
		if (draft === undefined) return
		if (draft.trim() !== saved) await onSave(draft.trim())
		// Only drop the draft if the box still holds what was saved; otherwise the user has typed on.
		if (latest.current === draft) setDraft(undefined)
	}
	return (
		<div className="space-y-1.5 py-2">
			<Label className="text-sm font-medium text-foreground" htmlFor={id}>
				{label}
			</Label>
			<Input
				aria-label={label}
				className="font-mono"
				id={id}
				onBlur={() => void commit()}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault()
						void commit()
					} else if (event.key === "Escape" && draft !== undefined) {
						event.stopPropagation()
						setDraft(undefined)
					}
				}}
				placeholder={placeholder}
				spellCheck={false}
				value={draft ?? saved}
			/>
			{draft === undefined && children}
		</div>
	)
}

function MmPathLine({ label, path }: { label: string; path: string }) {
	return (
		<div className="flex min-w-0 gap-1" title={path}>
			<span className="shrink-0">{label}</span>{" "}
			<span className="min-w-0 truncate text-left font-mono" dir="rtl">
				<bdi dir="ltr">{path}</bdi>
			</span>
		</div>
	)
}

/** Where things stand: ready (and how to start one), or why not and what fixes it. */
function Status({ state, hideReason }: { state: WorktreeState; hideReason: boolean }) {
	const { availability } = state
	const where = availability.modules?.length ? `in mm worktrees of ${availability.modules.join(", ")}` : "in a Git worktree"
	const fixInFolder = availability.fix === "repository" || availability.fix === "commit"
	return (
		<div className="space-y-1 py-2">
			{!hideReason && (
				<Feedback ok={availability.available} testId="worktrees-status">
					{availability.available
						? `Ready. Pick New worktree under the message box to start a thread ${where}.`
						: (availability.reason ?? "A worktree can't be made here.")}
					{fixInFolder && (
						<>
							{" "}
							<LinkButton
								id={WORKTREE_CONTROLS.folder}
								onClick={() => void threadWorktreeAction("openSourceControl")}>
								Open Source Control
							</LinkButton>
						</>
					)}
				</Feedback>
			)}
			{availability.mmCwd && (
				<div className="ph-no-capture pl-[18px] text-xs text-description">
					<MmPathLine label="mm working folder" path={availability.mmCwd} />
					{availability.mmConfigPath && <MmPathLine label="Config file" path={availability.mmConfigPath} />}
				</div>
			)}
		</div>
	)
}

/**
 * Settings › Tools › Worktrees: the mode, mm's paths, this workspace's switch and settled cleanup.
 * Every change saves as it's made and the status under it says whether a new thread can use a worktree.
 */
export function WorktreeSettings() {
	const { state, refresh, error } = useWorktree()
	const [selected, setSelected] = useState<string[]>([])
	const [warnings, setWarnings] = useState<Record<string, string>>({})
	const [message, setMessage] = useState<string>()
	const [busy, setBusy] = useState(false)
	// A control to focus, and how to bring it into view.
	const [focusNext, setFocusNext] = useState<{ id: string; block: ScrollLogicalPosition }>()
	const [landed, setLanded] = useState(false)

	// Every link here ("Turn on in Settings", a failed thread's or an automation's "Worktree settings",
	// search) opens the Worktrees row and highlights it. The shell focuses Mode, often before these
	// settings have loaded, so once they have, focus whatever fixes what's in the way now.
	useEffect(() => {
		const row = document.getElementById(settingsRowElementId("tools.worktrees"))
		if (!row) return
		const check = () => {
			if (row.classList.contains(TARGET_HIGHLIGHT_CLASS)) setLanded(true)
		}
		check()
		const observer = new MutationObserver(check)
		observer.observe(row, { attributes: true, attributeFilter: ["class"] })
		return () => observer.disconnect()
	}, [])
	useEffect(() => {
		if (!landed || !state) return
		setLanded(false)
		// The shell scrolled while this row was still empty, so center the control now it's here.
		setFocusNext({ id: fixControl(state), block: "center" })
	}, [landed, state])
	useEffect(() => {
		if (!focusNext) return
		const frame = requestAnimationFrame(() => {
			const element = document.getElementById(focusNext.id) ?? document.getElementById(WORKTREE_CONTROLS.mode)
			const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
			element?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: focusNext.block })
			element?.focus({ preventScroll: true })
			setFocusNext(undefined)
		})
		return () => cancelAnimationFrame(frame)
	}, [focusNext])

	const run = async (action: () => Promise<void>) => {
		setBusy(true)
		setMessage(undefined)
		try {
			await action()
			await refresh(true)
		} catch (error) {
			setMessage(worktreeErrorText(error))
		} finally {
			setBusy(false)
		}
	}
	if (!state) return error ? <InlineNotice tone="error">{error}</InlineNotice> : null

	const { settings, availability } = state
	const save = async (change: Partial<ThreadWorktreeSettings>) => {
		await run(async () => {
			// Only what changed goes to the host, which merges it into what's saved: Settings can be open in
			// another window, and a whole copy of what this one last saw would undo that window's change.
			await threadWorktreeAction("configure", "", change)
			// Turning worktrees on from Off, here, means using them here: undo this workspace's off switch
			// too, so one pick is enough (the old "Off for this workspace" switch was easy to flip by mistake).
			if (settings.mode === "off" && change.mode && change.mode !== "off" && availability.workspaceOff)
				await threadWorktreeAction("workspaceOff", "", { disabled: false })
		})
	}
	const showMm = settings.mode === "mm" || !!settings.mmPath
	// The folder has mm config but mm isn't what worktrees use here yet. In mm mode the mm.js box says what's left.
	const mmHint = state.mmConfigFile && settings.mode !== "mm" && !availability.modules && !(settings.mmPath && state.mmFound)
	// mm.js unset or missing: said under its box, not again in the status.
	const mmPathProblem = settings.mmPath ? state.mmFound === false : settings.mode === "mm"
	const confirming = Object.keys(warnings).length > 0

	return (
		<section aria-label="Worktrees" className="mt-2 flex flex-col" id="worktree-features">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
				<div className="min-w-[140px] flex-1">
					<Label className="text-sm font-medium text-foreground" htmlFor={WORKTREE_CONTROLS.mode}>
						Mode
					</Label>
					<p className="m-0 mt-0.5 text-xs text-description">{MODE_DESCRIPTIONS[settings.mode]}</p>
				</div>
				<Select
					disabled={busy}
					onValueChange={(mode) => {
						if (mode !== settings.mode) void save({ mode: mode as WorktreeMode })
					}}
					value={settings.mode}>
					<SelectTrigger aria-label="Worktrees mode" className="w-36 shrink-0" id={WORKTREE_CONTROLS.mode}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="off">Off</SelectItem>
						<SelectItem value="git">Git worktree</SelectItem>
						<SelectItem value="mm">mm</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{mmHint && (
				<InlineNotice
					actions={
						<Button
							data-testid="worktrees-use-mm"
							disabled={busy}
							id={WORKTREE_CONTROLS.useMm}
							onClick={() =>
								void save({ mode: "mm" }).then(() => {
									if (!settings.mmPath) setFocusNext({ id: WORKTREE_CONTROLS.mm, block: "nearest" })
								})
							}
							size="sm"
							variant="secondary">
							Use mm
						</Button>
					}
					className="my-1"
					data-testid="worktrees-mm-hint"
					tone="info">
					<span className="min-w-0 flex-1">
						This folder is an mm workspace (<span className="font-mono">{state.mmConfigFile}</span>).
					</span>
				</InlineNotice>
			)}

			{showMm && (
				<>
					<PathField
						id={WORKTREE_CONTROLS.mm}
						label="Path to mm.js"
						onSave={(mmPath) => save({ mmPath })}
						placeholder="/path/to/mm.js"
						saved={settings.mmPath}>
						{settings.mmPath && state.mmFound ? (
							<Feedback ok testId="worktrees-mm-found">
								Found mm.js.
							</Feedback>
						) : mmPathProblem ? (
							<Feedback testId="worktrees-mm-found">
								{settings.mmPath ? (
									<>
										Couldn't find mm.js at <span className="font-mono">{settings.mmPath}</span>.
									</>
								) : (
									"Set the path to mm.js to use mm."
								)}
							</Feedback>
						) : null}
					</PathField>
					<PathField
						id={WORKTREE_CONTROLS.node}
						label="Path to node"
						onSave={(nodePath) => save({ nodePath })}
						placeholder="node"
						saved={settings.nodePath}
					/>
				</>
			)}

			{/* With Mode off this switch can't turn worktrees on by itself, so the status points at Mode instead. */}
			{settings.mode !== "off" && (
				<div className="flex items-start justify-between gap-4 py-2">
					<div className="min-w-0 flex-1">
						<Label className="text-sm font-medium text-foreground" htmlFor={WORKTREE_CONTROLS.workspace}>
							Use worktrees in this workspace
						</Label>
						<p className="m-0 mt-0.5 text-xs text-description">
							Turn off to keep this folder's threads in your workspace.
						</p>
					</div>
					<Switch
						checked={!availability.workspaceOff}
						className="shrink-0"
						disabled={busy}
						id={WORKTREE_CONTROLS.workspace}
						onCheckedChange={(on) =>
							void run(() => threadWorktreeAction("workspaceOff", "", { disabled: !on }).then(() => {}))
						}
						size="lg"
					/>
				</div>
			)}

			<Status hideReason={mmPathProblem && availability.fix === "mm"} state={state} />
			{(message || error) && (
				<InlineNotice className="my-1" tone="error">
					{message || error}
				</InlineNotice>
			)}

			<div className="mt-1 space-y-2 border-t border-editor-group-border pt-3" data-testid="worktrees-settled">
				<div className="text-sm font-medium text-foreground">{state.settled.length} settled worktrees</div>
				{state.settled.length === 0 ? (
					<p className="m-0 text-xs text-description">Worktrees of settled threads show up here for cleanup.</p>
				) : (
					<div className="flex flex-col gap-1">
						{state.settled.map((mapping) => (
							<div key={mapping.threadId}>
								<VSCodeCheckbox
									checked={selected.includes(mapping.threadId)}
									disabled={busy}
									onChange={(event) => {
										const checked = (event.target as HTMLInputElement).checked
										setSelected((current) =>
											checked
												? current.includes(mapping.threadId)
													? current
													: [...current, mapping.threadId]
												: current.filter((id) => id !== mapping.threadId),
										)
									}}>
									<span className="ph-no-capture break-all font-mono text-xs">{mapping.branch}</span>
									<span className="block text-xs text-description">
										{mapping.transferredDiff ? "Brought in / taken over" : "Never brought in"}
									</span>
								</VSCodeCheckbox>
								{warnings[mapping.threadId] && (
									<InlineNotice className="mt-1" tone="warning">
										{warnings[mapping.threadId]}
									</InlineNotice>
								)}
							</div>
						))}
					</div>
				)}
				{selected.length > 0 && (
					<div className="flex justify-end">
						<Button
							disabled={busy}
							onClick={() =>
								void run(async () => {
									const nextWarnings: Record<string, string> = {}
									for (const id of selected) {
										const result = await threadWorktreeAction("remove", id, undefined, !!warnings[id])
										if (result.warning) nextWarnings[id] = result.warning
									}
									setWarnings(nextWarnings)
									setSelected(Object.keys(nextWarnings))
								})
							}
							size="sm"
							variant={confirming ? "danger" : "secondary"}>
							{confirming ? "Confirm removal of selected worktrees" : `Remove ${selected.length} selected`}
						</Button>
					</div>
				)}
			</div>
		</section>
	)
}
