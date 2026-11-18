import { NotebookActionRequest } from "@shared/proto/cline/task_group"
import {
	ABOUT_YOU_ID,
	ABOUT_YOU_TOKEN_CAP,
	estimateTokens,
	type NotebookDiffLine,
	type NotebookNoteMeta,
	type NotebookVersion,
} from "@shared/task-groups"
import { useCallback, useEffect, useState } from "react"
import { Breadcrumb } from "@/components/chat/task-header/Breadcrumb"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { DocEditor, type DocEditorMode } from "@/components/docEditor/DocEditor"
import { useOneView } from "@/components/oneView/OneViewContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskGroupServiceClient } from "@/services/grpc-client"
import { AboutYouMeter, aboutYouLimitReason } from "./AboutYouMeter"
import { NotebookDiff } from "./NotebookDiff"
import { formatNoteSize, openNote } from "./useTaskGroup"

const FIELD_CLASS =
	"w-full rounded-xs border border-input-border bg-input-background px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"

type Version = NotebookVersion & { diff: NotebookDiffLine[] }
interface NoteData {
	versions: Version[]
	conversions: { kind: string; path: string }[]
}

export function NotebookNoteView({
	taskGroupId,
	taskTitle,
	note,
	onBack,
	initialMode,
	otherTokens = 0,
}: {
	taskGroupId: string
	taskTitle: string
	note: NotebookNoteMeta
	onBack: () => void
	/** A note just created opens in Edit. */
	initialMode?: DocEditorMode
	/** About you: the other notes' tokens, so the meter shows the whole cost as you type. */
	otherTokens?: number
}) {
	const aboutYou = taskGroupId === ABOUT_YOU_ID
	const { hideTaskGroupView, navigateToTaskGroup } = useExtensionState()
	const oneView = useOneView()
	const [history, setHistory] = useState(false)
	const [data, setData] = useState<NoteData>()
	const [selected, setSelected] = useState<string>()
	const [kind, setKind] = useState<string>()
	const [converting, setConverting] = useState(false)
	const [isGlobal, setGlobal] = useState(false)
	const [description, setDescription] = useState(note.description)
	const [preview, setPreview] = useState<{ path: string; content: string; revision: string }>()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const [name, setName] = useState(note.name)
	const [noteDescription, setNoteDescription] = useState(note.description)
	const [bodyTokens, setBodyTokens] = useState(note.tokens ?? 0)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const call = useCallback(
		async (action: string, extra: Partial<NotebookActionRequest> = {}) => {
			const response = await TaskGroupServiceClient.notebookAction(
				NotebookActionRequest.create({ taskGroupId, slug: note.slug, action, ...extra }),
			)
			return JSON.parse(response.json)
		},
		[taskGroupId, note.slug],
	)
	const load = useCallback(async () => setData(await call("history")), [call])
	useEffect(() => {
		void load().catch((error) => setError(String(error)))
	}, [load])
	const run = async (operation: () => Promise<void>) => {
		setBusy(true)
		setError(undefined)
		try {
			await operation()
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
		}
	}
	const current = data?.versions[data.versions.length - 1]
	const version = data?.versions.find((version) => version.id === selected)
	return (
		<div className="flex flex-1 flex-col overflow-hidden" data-testid="notebook-note-view">
			<div className="px-4 pt-2 pb-1">
				<div
					className="flex h-7.5 items-center gap-1 rounded-xs border border-transparent pl-0.5 pr-1 bg-(--vscode-toolbar-hoverBackground)/40"
					data-testid="notebook-note-header">
					{oneView.listToggle}
					<Breadcrumb
						crumbs={[
							...(oneView.enabled
								? []
								: [{ id: "home", kind: "home" as const, label: "Home", onSelect: hideTaskGroupView }]),
							{
								id: taskGroupId,
								kind: "task",
								label: taskTitle,
								onSelect: () => (aboutYou ? onBack() : navigateToTaskGroup(taskGroupId, "home")),
							},
							{
								id: note.slug,
								kind: "thread",
								label: note.name,
								onSelect: history ? () => setHistory(false) : undefined,
							},
							...(history ? [{ id: "history", kind: "thread" as const, label: "History" }] : []),
						]}
					/>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto px-4 py-2 text-xs">
				<div className="mb-3 flex items-center gap-2">
					<Button onClick={onBack} size="xs" variant="secondary">
						<span aria-hidden className="codicon codicon-arrow-left text-[11px]!" />
						{aboutYou ? "About you" : "Notebook"}
					</Button>
					<h2 className="ph-no-capture m-0 min-w-0 flex-1 truncate text-[14px] font-semibold">{note.name}</h2>
					{!history && (
						<>
							<Button
								onClick={() => openNote(taskGroupId, note.slug)}
								size="xs"
								title="Open the markdown file in an editor tab"
								variant="ghost">
								<span aria-hidden className="codicon codicon-go-to-file text-[11px]!" />
								Open as file
							</Button>
							<Button
								onClick={() => {
									setHistory(true)
									void run(load)
								}}
								size="xs"
								variant="secondary">
								<span aria-hidden className="codicon codicon-history text-[11px]!" />
								History
							</Button>
						</>
					)}
				</div>
				{history ? (
					<>
						<div className="mb-2 text-description">{data?.versions.length ?? 0} versions</div>
						<div className="mb-3 rounded-xs border border-editor-group-border p-1">
							{[...(data?.versions ?? [])].reverse().map((entry, i, versions) => (
								<button
									aria-pressed={selected === entry.id}
									className={cn(
										"block w-full cursor-pointer rounded-xs border-0 bg-transparent px-2 py-1.5 text-left text-foreground hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)",
										selected === entry.id && "bg-selection text-selection-foreground hover:bg-selection",
									)}
									key={entry.id}
									onClick={() => setSelected(entry.id)}
									type="button">
									<div>
										{i === 0
											? "Current"
											: i === versions.length - 1
												? "Original"
												: `Version ${versions.length - i}`}
									</div>
									<div className={cn("text-[11px]", selected === entry.id ? "opacity-80" : "text-description")}>
										{new Date(entry.ts).toLocaleString()} · {entry.by}
									</div>
								</button>
							))}
						</div>
						{version && version.id !== current?.id && (
							<div>
								<div className="mb-2 flex items-center gap-2">
									<span className="flex-1 text-description">Selected version → current</span>
									<Button
										disabled={busy}
										onClick={() =>
											void run(async () => {
												await call("restore", { versionId: version.id })
												await load()
												setSelected(undefined)
											})
										}
										size="xs">
										Restore
									</Button>
								</div>
								<NotebookDiff key={version.id} lines={version.diff} />
							</div>
						)}
					</>
				) : (
					<>
						{data && (
							<DocEditor
								blockedReason={
									aboutYou && bodyTokens > (note.tokens ?? 0) && otherTokens + bodyTokens > ABOUT_YOU_TOKEN_CAP
										? aboutYouLimitReason(otherTokens + bodyTokens)
										: undefined
								}
								emptyText={
									aboutYou
										? "Empty. Switch to Edit and write one preference per line."
										: "Empty. Switch to Edit to write this note."
								}
								fields={
									<div className="grid gap-2" data-testid="note-fields">
										<label className="block">
											<span className="mb-1 block text-[11px] text-description">Name</span>
											<input
												className={FIELD_CLASS}
												onChange={(event) => setName(event.target.value)}
												value={name}
											/>
										</label>
										{!aboutYou && (
											<label className="block">
												<span className="mb-1 block text-[11px] text-description">
													Description{" "}
													<span className="opacity-75">(what agents see in the notes index)</span>
												</span>
												<input
													className={FIELD_CLASS}
													onChange={(event) => setNoteDescription(event.target.value)}
													placeholder="What it covers, in one line"
													value={noteDescription}
												/>
											</label>
										)}
									</div>
								}
								fieldsDirty={name.trim() !== note.name || noteDescription.trim() !== note.description}
								initialMode={initialMode}
								label={`${note.name} body`}
								onDiscardFields={() => {
									setName(note.name)
									setNoteDescription(note.description)
								}}
								onDraftChange={(body) => setBodyTokens(estimateTokens(body))}
								onSave={async (body) => {
									await call("save", {
										content: body,
										baseContent: current?.content ?? "",
										name: name.trim() || note.name,
										description: aboutYou ? note.description : noteDescription.trim(),
									})
									await load()
								}}
								status={
									aboutYou ? (
										<AboutYouMeter tokens={otherTokens + bodyTokens} />
									) : (
										<span>
											{formatNoteSize(note.size)} · about {bodyTokens} tokens when read
										</span>
									)
								}
								value={current?.content ?? ""}
							/>
						)}
						{data?.conversions.map((link) => (
							<LinkButton
								className="mt-2 flex items-center gap-1"
								key={link.path}
								onClick={() =>
									void run(async () => {
										await call("open_conversion", { versionId: link.path })
									})
								}>
								<span aria-hidden className="codicon codicon-link-external text-[11px]!" />
								Converted to {link.kind} › {link.path}
							</LinkButton>
						))}
						<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-editor-group-border pt-3">
							{confirmDelete ? (
								<InlineNotice
									actions={
										<>
											<Button
												disabled={busy}
												onClick={() =>
													void run(async () => {
														await call("delete")
														onBack()
													})
												}
												size="xs">
												Delete
											</Button>
											<Button onClick={() => setConfirmDelete(false)} size="xs" variant="secondary">
												Cancel
											</Button>
										</>
									}
									className="w-full"
									tone="warning">
									Delete {note.name}? Its History keeps the last version.
								</InlineNotice>
							) : (
								<Button onClick={() => setConfirmDelete(true)} size="xs" variant="ghost">
									<span aria-hidden className="codicon codicon-trash text-[11px]!" />
									Delete
								</Button>
							)}
						</div>
						<div className={aboutYou ? "hidden" : "mt-3"}>
							{!converting ? (
								<Button onClick={() => setConverting(true)} size="xs" variant="secondary">
									Convert to…
								</Button>
							) : !kind ? (
								<div className="flex gap-2">
									{["rule", "skill", "workflow"].map((kind) => (
										<Button key={kind} onClick={() => setKind(kind)} size="xs" variant="secondary">
											{kind[0].toUpperCase() + kind.slice(1)}
										</Button>
									))}
									<Button onClick={() => setConverting(false)} size="xs" variant="ghost">
										Cancel
									</Button>
								</div>
							) : (
								<div className="rounded-xs border border-editor-group-border bg-code p-3">
									<div className="mb-2 text-[13px] font-semibold">Convert to {kind}</div>
									<div className="mb-2 flex items-center gap-1.5">
										<span className="mr-1 font-medium">Where</span>
										{[false, true].map((global) => (
											<Button
												key={String(global)}
												onClick={() => {
													setGlobal(global)
													setPreview(undefined)
												}}
												size="xs"
												variant={isGlobal === global ? "default" : "secondary"}>
												{global ? "Global" : "Workspace"}
											</Button>
										))}
									</div>
									{kind === "skill" && (
										<div className="mb-2 space-y-1">
											<label className="block font-medium" htmlFor="notebook-skill-description">
												Description
											</label>
											<p className="m-0 text-description">Decides when the skill loads.</p>
											<Input
												aria-label="Skill description"
												className="text-xs"
												id="notebook-skill-description"
												onChange={(event) => {
													setDescription(event.target.value)
													setPreview(undefined)
												}}
												value={description}
											/>
										</div>
									)}
									{preview && (
										<div className="my-2">
											<div className="ph-no-capture mb-1 break-all font-mono text-[11px] text-description">
												{preview.path}
											</div>
											<NotebookDiff lines={[{ kind: "add", text: preview.content }]} />
										</div>
									)}
									<div className="flex justify-end gap-2">
										<Button
											disabled={busy}
											onClick={() => {
												setKind(undefined)
												setPreview(undefined)
											}}
											size="xs"
											variant="secondary">
											Back
										</Button>
										<Button
											disabled={busy || (kind === "skill" && !description.trim())}
											onClick={() =>
												void run(async () => {
													if (!preview) {
														setPreview(await call("convert_preview", { kind, isGlobal, description }))
														return
													}
													await call("convert", {
														kind,
														isGlobal,
														description,
														versionId: preview.revision,
													})
													await load()
													setConverting(false)
													setKind(undefined)
													setPreview(undefined)
												})
											}
											size="xs">
											{preview ? "Create file" : "Review file"}
										</Button>
									</div>
								</div>
							)}
						</div>
					</>
				)}
				{error && (
					<InlineNotice className="mt-2" tone="error">
						{error}
					</InlineNotice>
				)}
			</div>
		</div>
	)
}
