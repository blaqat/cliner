import { StringRequest } from "@shared/proto/cline/common"
import { ExportSkillsetRequest } from "@shared/proto/cline/skillset"
import { SKILLSET_HOW_TO, type SkillsetExportResult, type SkillsetItem, slugifySkillName } from "@shared/skillsets"
import { useMemo, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SkillsetServiceClient } from "@/services/grpc-client"
import { getCurrentPlatform } from "@/utils/platformUtils"
import { formatSize, RunsCodeChip } from "./SkillBits"
import { useSkillsetLibrary } from "./useSkillsetLibrary"

const FIELD_CLASS =
	"w-full rounded-xs border border-solid border-input-border bg-input-background px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** "Reveal in Finder" on macOS, "Reveal in File Explorer" on Windows, "Open containing folder" elsewhere. */
export function revealLabel(): string {
	const platform = getCurrentPlatform()
	return platform === "mac" ? "Reveal in Finder" : platform === "windows" ? "Reveal in File Explorer" : "Open containing folder"
}

/** The line Copy how-to puts on the clipboard, to paste next to the file. */
export function howToText(result: SkillsetExportResult, name: string, skills: number, workflows: number): string {
	const what = [skills ? plural(skills, "skill") : "", workflows ? plural(workflows, "workflow") : ""]
		.filter(Boolean)
		.join(" and ")
	return `Here's ${name}, ${what} for Cline. ${SKILLSET_HOW_TO.replace("the file", result.fileName ?? "the file")}`
}

const key = (item: SkillsetItem) => `${item.kind}:${item.path}`

/**
 * Share a skillset: pick skills and workflows from both scopes, name the set,
 * save it with the save dialog. After saving: Reveal and Copy how-to, the
 * line that tells the receiver to hold Shift and drop it on Cline.
 */
export function ShareSkillsetPage({ onBack }: { onBack: () => void }) {
	const { library, error: loadError } = useSkillsetLibrary({ includeFiles: true })
	const [picked, setPicked] = useState<Set<string>>(new Set())
	const [name, setName] = useState("")
	const [nameTouched, setNameTouched] = useState(false)
	const [description, setDescription] = useState("")
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string>()
	const [saved, setSaved] = useState<SkillsetExportResult>()
	const [copied, setCopied] = useState(false)

	const all = useMemo(() => [...(library?.skills ?? []), ...(library?.workflows ?? [])], [library])
	const chosen = all.filter((item) => picked.has(key(item)))
	// The name follows the first pick until the user types one.
	const effectiveName = nameTouched ? name : (chosen[0]?.name ?? "")
	const fileName = `${slugifySkillName(effectiveName) || "skillset"}.skillset.zip`
	const bytes = chosen.reduce((sum, item) => sum + item.files.reduce((total, file) => total + file.size, 0), 0)
	const runsCode = chosen.filter((item) => item.runsCode).length
	const skipped = chosen.flatMap((item) => (item.skippedFiles ?? []).map((file) => `${item.name}/${file}`))

	const toggle = (item: SkillsetItem) =>
		setPicked((current) => {
			const next = new Set(current)
			if (next.has(key(item))) next.delete(key(item))
			else next.add(key(item))
			return next
		})

	const save = async () => {
		setSaving(true)
		setError(undefined)
		try {
			const response = await SkillsetServiceClient.exportSkillset(
				ExportSkillsetRequest.create({
					name: effectiveName,
					description,
					itemsJson: JSON.stringify(chosen.map((item) => ({ kind: item.kind, path: item.path }))),
				}),
			)
			const result = JSON.parse(response.json) as SkillsetExportResult
			if (!result.cancelled) setSaved(result)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setSaving(false)
		}
	}

	const header = (
		<div className="mb-3 flex items-center gap-2">
			<Button aria-label="Back to skills" onClick={onBack} size="xs" variant="icon">
				<span aria-hidden className="codicon codicon-arrow-left" />
			</Button>
			<span className="text-[13px] font-semibold">Share a skillset</span>
		</div>
	)

	if (saved) {
		const skills = chosen.filter((item) => item.kind === "skill").length
		const workflows = chosen.length - skills
		return (
			<div data-testid="share-skillset-saved">
				{header}
				<div className="rounded-xs border border-solid border-editor-group-border bg-code px-2.5 py-2 text-xs">
					<div className="flex items-center gap-1.5">
						<span aria-hidden className="codicon codicon-pass-filled text-success" />
						<span className="font-semibold">Saved {saved.fileName}</span>
					</div>
					<div className="mt-0.5 truncate text-[11px] text-description" title={saved.path}>
						{saved.folder ?? saved.path?.replace(/[\\/][^\\/]+$/, "")} · {plural(saved.items ?? 0, "item")} ·{" "}
						{formatSize(saved.bytes ?? 0)}
					</div>
					<div className="mt-2 flex flex-wrap gap-1.5">
						<Button
							onClick={() =>
								void SkillsetServiceClient.revealSkillset(
									StringRequest.create({ value: saved.path ?? "" }),
								).catch((error) => setError(error instanceof Error ? error.message : String(error)))
							}
							size="xs">
							{revealLabel()}
						</Button>
						<Button
							onClick={() => {
								void navigator.clipboard
									.writeText(howToText(saved, effectiveName, skills, workflows))
									.then(() => {
										setCopied(true)
										setTimeout(() => setCopied(false), 1600)
									})
							}}
							size="xs"
							variant="secondary">
							{copied ? "Copied" : "Copy how-to"}
						</Button>
					</div>
					<p className="m-0 mt-2 text-[11px] text-description">
						Copy how-to copies a line to send with the file: {howToText(saved, effectiveName, skills, workflows)}
					</p>
					{saved.skipped && saved.skipped.length > 0 && (
						<p className="m-0 mt-1.5 text-[11px] text-description">Left out: {saved.skipped.join(", ")}</p>
					)}
				</div>
				{saved.layout && (
					<div className="mt-3">
						<div className="mb-1 text-[11px] font-medium text-description">Inside the zip</div>
						<pre className="m-0 rounded-xs bg-(--vscode-editor-background) px-2 py-1.5 font-mono text-[11px] leading-5 break-all whitespace-pre-wrap">
							{saved.layout.join("\n")}
						</pre>
					</div>
				)}
				<div className="mt-3 flex gap-1.5">
					<Button
						onClick={() => {
							setSaved(undefined)
							setPicked(new Set())
							setName("")
							setNameTouched(false)
							setDescription("")
						}}
						size="xs"
						variant="secondary">
						Share another
					</Button>
					<Button onClick={onBack} size="xs">
						Done
					</Button>
				</div>
			</div>
		)
	}

	return (
		<div data-testid="share-skillset">
			{header}
			<label className="mb-2 block text-[11px] text-description">
				Name
				<input
					aria-label="Skillset name"
					className={cn(FIELD_CLASS, "mt-0.5")}
					onChange={(event) => {
						setNameTouched(true)
						setName(event.target.value)
					}}
					placeholder="Pick something below, or type a name"
					value={effectiveName}
				/>
				<span className="mt-0.5 block">Saves as {fileName}</span>
			</label>
			<label className="mb-3 block text-[11px] text-description">
				What it's for (optional; the receiver sees it)
				<input
					aria-label="What it's for"
					className={cn(FIELD_CLASS, "mt-0.5")}
					maxLength={300}
					onChange={(event) => setDescription(event.target.value)}
					placeholder="My PR review helpers"
					value={description}
				/>
			</label>
			{loadError && (
				<InlineNotice className="mb-2" tone="error">
					Couldn't list your skills: {loadError}
				</InlineNotice>
			)}
			{!library && !loadError && <div className="text-[11px] text-description">Loading your skills and workflows…</div>}
			{library && (
				<>
					<PickList
						empty="No skills yet. Make one with New skill… on the Skills tab, or ask Cline: “can we make this a skill?”"
						items={library.skills}
						onToggle={toggle}
						picked={picked}
						title="Skills"
					/>
					<PickList
						empty="No workflows yet."
						items={library.workflows}
						onToggle={toggle}
						picked={picked}
						title="Workflows"
					/>
				</>
			)}
			<div className="sticky bottom-0 -mx-3 mt-2 border-0 border-t border-solid border-editor-group-border bg-menu px-3 pt-2 pb-1">
				<div className="flex flex-wrap items-center gap-1.5 text-[11px] text-description">
					{chosen.length ? (
						<>
							<span>
								{plural(chosen.length, "item")} · {formatSize(bytes)}
							</span>
							{runsCode > 0 && <RunsCodeChip label={`${runsCode} runs code`} />}
						</>
					) : (
						<span>Pick at least one skill or workflow to save.</span>
					)}
				</div>
				{skipped.length > 0 && (
					<div className="mt-1 text-[11px] text-description">
						Leaves out {skipped.slice(0, 3).join(", ")}
						{skipped.length > 3 ? ` and ${skipped.length - 3} more` : ""}: dotfiles like .env can hold secrets.
					</div>
				)}
				{error && (
					<InlineNotice className="mt-1.5" tone="error">
						{error}
					</InlineNotice>
				)}
				<div className="mt-1.5 flex justify-end gap-1.5">
					<Button onClick={onBack} size="xs" variant="secondary">
						Cancel
					</Button>
					<Button
						disabled={!chosen.length || !effectiveName.trim() || saving}
						onClick={() => void save()}
						size="xs"
						title={
							!chosen.length
								? "Pick at least one skill or workflow"
								: !effectiveName.trim()
									? "Name the skillset"
									: undefined
						}>
						{saving ? "Saving…" : "Save skillset…"}
					</Button>
				</div>
			</div>
		</div>
	)
}

function PickList({
	title,
	items,
	picked,
	onToggle,
	empty,
}: {
	title: string
	items: SkillsetItem[]
	picked: Set<string>
	onToggle: (item: SkillsetItem) => void
	empty: string
}) {
	const count = items.filter((item) => picked.has(key(item))).length
	return (
		<fieldset className="m-0 mb-3 min-w-0 border-0 p-0">
			<legend className="mb-1 p-0 text-[11px] font-medium text-description">
				{title}
				{items.length > 0 && ` · ${count} of ${items.length}`}
			</legend>
			{items.length === 0 ? (
				<p className="m-0 text-[11px] text-description">{empty}</p>
			) : (
				<ul className="m-0 flex list-none flex-col gap-px p-0">
					{items.map((item) => {
						const checked = picked.has(key(item))
						return (
							<li key={key(item)}>
								<label
									className={cn(
										"flex min-w-0 cursor-pointer items-start gap-2 rounded-xs px-2 py-1.5 text-xs hover:bg-list-background-hover",
										checked && "bg-(--vscode-list-inactiveSelectionBackground)",
									)}>
									<input
										checked={checked}
										className="m-0 mt-0.5 shrink-0 accent-(--vscode-button-background)"
										onChange={() => onToggle(item)}
										type="checkbox"
									/>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="flex min-w-0 items-center gap-1.5">
											<span className="min-w-0 truncate">
												{item.kind === "workflow" ? `/${item.name}` : item.name}
											</span>
											{item.runsCode && <RunsCodeChip />}
										</span>
										<span className="truncate text-[11px] text-description">
											{item.isGlobal ? "All projects" : "This workspace"}
											{item.kind === "skill" && ` · ${plural(item.files.length, "file")}`}
											{item.description ? ` · ${item.description}` : ""}
										</span>
									</span>
								</label>
							</li>
						)
					})}
				</ul>
			)}
		</fieldset>
	)
}
