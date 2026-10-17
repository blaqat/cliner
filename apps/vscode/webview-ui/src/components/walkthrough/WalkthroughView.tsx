import { StringRequest } from "@shared/proto/cline/common"
import type { ChangeWalkthrough, WalkthroughRequest, WalkthroughScope, WalkthroughStop } from "@shared/Walkthrough"
import { useCallback, useEffect, useRef, useState } from "react"
import { Breadcrumb, type Crumb } from "@/components/chat/task-header/Breadcrumb"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

const request = (value: WalkthroughRequest) => StringRequest.create({ value: JSON.stringify(value) })
const QUICK_NOTES = ["Why this approach?", "Add a test for this.", "Rename for clarity."]

/** Deliberately plain: the page's data and actions are independent of its eventual visual design. */
export default function WalkthroughView({ taskId, onDone }: { taskId: string; onDone: () => void }) {
	const { apiConfigProfiles, currentTaskItem, taskGroups, navigateToTaskGroup } = useExtensionState()
	const [scope, setScope] = useState<WalkthroughScope>("thread")
	const [walk, setWalk] = useState<ChangeWalkthrough>()
	const [profileId, setProfileId] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const [notes, setNotes] = useState<Record<string, string>>({})
	const [overallNote, setOverallNote] = useState("")
	const [reviewed, setReviewed] = useState<Record<string, boolean>>({})
	const [confirmation, setConfirmation] = useState<{ fileId: string; hunkId?: string }>()
	const sequence = useRef(0)
	const fingerprint = useRef<string>()
	const input = { taskId, scope, fingerprint: walk?.fingerprint }
	const load = useCallback(async () => {
		const id = ++sequence.current
		setBusy(true)
		setError("")
		try {
			const response = await TaskServiceClient.getChangeWalkthrough(request({ taskId, scope }))
			if (id === sequence.current) {
				const next = JSON.parse(response.value) as ChangeWalkthrough
				if (fingerprint.current && fingerprint.current !== next.fingerprint) {
					setNotes({})
					setReviewed({})
					setConfirmation(undefined)
				}
				fingerprint.current = next.fingerprint
				setWalk(next)
			}
		} catch (error) {
			if (id === sequence.current) setError(String(error))
		} finally {
			if (id === sequence.current) setBusy(false)
		}
	}, [taskId, scope])
	useEffect(() => {
		setWalk(undefined)
		setNotes({})
		setReviewed({})
		setOverallNote("")
		setConfirmation(undefined)
		void load()
		return () => {
			sequence.current++
		}
	}, [load])
	const run = async (operation: () => Promise<void>) => {
		setBusy(true)
		setError("")
		try {
			await operation()
		} catch (error) {
			setError(String(error))
		} finally {
			setBusy(false)
		}
	}
	const generate = () =>
		run(async () => {
			const response = await TaskServiceClient.generateChangeWalkthrough(
				request({ ...input, profileId, regenerate: walk?.source === "generated" }),
			)
			setWalk(JSON.parse(response.value))
			setReviewed({})
			setNotes({})
			setConfirmation(undefined)
		})
	const group = currentTaskItem?.taskGroupId ? taskGroups.find((g) => g.id === currentTaskItem.taskGroupId) : undefined
	const crumbs: Crumb[] = [
		...(group
			? [
					{
						id: `task:${group.id}`,
						kind: "task" as const,
						label: group.title,
						onSelect: () => navigateToTaskGroup(group.id),
					},
				]
			: [{ id: "task", kind: "task" as const, label: "Task" }]),
		{ id: taskId, kind: "thread", label: currentTaskItem?.title || "Thread", onSelect: onDone },
		{ id: `walkthrough:${taskId}`, kind: "page", label: "Walkthrough" },
	]
	const allStops = walk ? [...walk.chapters.flatMap((c) => c.stops), ...walk.support] : []
	const renderStop = (stop: WalkthroughStop) => (
		<article className="my-4 border border-description/30 p-2" key={stop.id}>
			<h3>{stop.title}</h3>
			<p className="whitespace-pre-wrap">{stop.prose}</p>
			{stop.hunkIds.map((id) => {
				const hunk = walk?.hunks.find((h) => h.id === id)
				if (!hunk) return null
				return (
					<details key={id} open>
						<summary>
							{hunk.path} · {id}
						</summary>
						<pre className="overflow-auto whitespace-pre text-[11px]">{hunk.patch}</pre>
						<button
							disabled={busy}
							onClick={() =>
								void run(async () => {
									await TaskServiceClient.openWalkthroughDiff(request({ ...input, fileId: hunk.fileId }))
								})
							}
							type="button">
							Open diff
						</button>{" "}
						<button
							disabled={busy || hunk.synthetic}
							onClick={() => setConfirmation({ fileId: hunk.fileId })}
							type="button">
							Revert file
						</button>{" "}
						<button
							disabled={busy || hunk.synthetic}
							onClick={() => setConfirmation({ fileId: hunk.fileId, hunkId: id })}
							type="button">
							Revert hunk
						</button>
					</details>
				)
			})}
			<label>
				<input
					checked={!!reviewed[stop.id]}
					onChange={(event) => setReviewed({ ...reviewed, [stop.id]: event.target.checked })}
					type="checkbox"
				/>{" "}
				Reviewed
			</label>
			<label className="block">
				Add note
				<textarea
					className="block w-full bg-input-background text-input-foreground"
					onChange={(event) => setNotes({ ...notes, [stop.id]: event.target.value })}
					value={notes[stop.id] ?? ""}
				/>
			</label>
			{QUICK_NOTES.map((text) => (
				<button
					key={text}
					onClick={() => setNotes({ ...notes, [stop.id]: [notes[stop.id], text].filter(Boolean).join("\n") })}
					type="button">
					{text}
				</button>
			))}
		</article>
	)
	return (
		<section className="flex h-full flex-col p-3" data-testid="walkthrough-page">
			<Breadcrumb crumbs={crumbs} />
			<div className="my-2 flex flex-wrap gap-2">
				<label>
					Scope{" "}
					<select disabled={busy} onChange={(event) => setScope(event.target.value as WalkthroughScope)} value={scope}>
						<option value="thread">This thread</option>
						<option value="last_turn">Last turn</option>
						<option value="git">Whole git diff</option>
					</select>
				</label>
				<label>
					Profile{" "}
					<select disabled={busy} onChange={(event) => setProfileId(event.target.value)} value={profileId}>
						<option value="">Choose profile</option>
						{apiConfigProfiles.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</label>
				<button disabled={busy || !profileId || !walk?.hunks.length} onClick={() => void generate()} type="button">
					{walk?.source === "generated" ? "Regenerate" : "Generate"}
				</button>
				<button disabled={busy} onClick={() => void load()} type="button">
					Refresh
				</button>
			</div>
			{error && <p role="alert">{error}</p>}
			{busy && <p role="status">Loading walkthrough…</p>}
			{confirmation && (
				<div className="my-2 border p-2" role="alert">
					Revert this {confirmation.hunkId ? "hunk" : "file"}? Later file edits prevent the revert.
					<button
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const response = await TaskServiceClient.revertWalkthroughChange(
									request({ ...input, ...confirmation, confirmed: true }),
								)
								setWalk(JSON.parse(response.value))
								setNotes({})
								setReviewed({})
								fingerprint.current = (JSON.parse(response.value) as ChangeWalkthrough).fingerprint
								setConfirmation(undefined)
							})
						}
						type="button">
						Confirm revert
					</button>{" "}
					<button onClick={() => setConfirmation(undefined)} type="button">
						Cancel
					</button>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-auto">
				{walk && (
					<>
						<h2>{walk.title}</h2>
						<p>{walk.focus}</p>
						{walk.warnings.map((warning) => (
							<p key={warning}>{warning}</p>
						))}
						<p>
							{walk.source === "fallback" ? "Grouped by turn. Generate groups by idea." : "Generated walkthrough"} ·{" "}
							{allStops.filter((s) => reviewed[s.id]).length}/{allStops.length} reviewed
						</p>
						{!walk.hunks.length && <p>No changes in this scope.</p>}
						{walk.chapters.map((chapter) => (
							<section key={chapter.id}>
								<h2>{chapter.title}</h2>
								{chapter.stops.map(renderStop)}
							</section>
						))}
						{walk.support.map(renderStop)}
					</>
				)}
				<label>
					Overall note
					<textarea
						className="block w-full bg-input-background text-input-foreground"
						onChange={(event) => setOverallNote(event.target.value)}
						value={overallNote}
					/>
				</label>
			</div>
			<button
				disabled={busy || !walk || !(overallNote.trim() || Object.values(notes).some((n) => n.trim()))}
				onClick={() =>
					void run(async () => {
						await TaskServiceClient.sendWalkthroughNotes(request({ ...input, stopNotes: notes, overallNote }))
						onDone()
					})
				}
				type="button">
				Send to thread
			</button>
		</section>
	)
}
