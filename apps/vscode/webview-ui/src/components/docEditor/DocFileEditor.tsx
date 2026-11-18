import { StringRequest } from "@shared/proto/cline/common"
import { DocRequest, SaveDocRequest } from "@shared/proto/cline/doc"
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { Button } from "@/components/ui/button"
import { DocServiceClient, FileServiceClient } from "@/services/grpc-client"
import { DocEditor } from "./DocEditor"

export type DocFileKind = "rule" | "workflow" | "skill"

export interface DocFileTarget {
	path: string
	kind: DocFileKind
	isGlobal: boolean
}

/** Lets a Rules panel row open its file in the doc editor instead of an editor tab. */
export const DocFileEditorContext = createContext<((target: DocFileTarget) => void) | undefined>(undefined)
export const useOpenDocFile = () => useContext(DocFileEditorContext)

/** The Rules panel's row types, as the doc editor's kinds. */
export function docKindOfRuleType(ruleType: string): DocFileKind {
	return ruleType === "workflow" ? "workflow" : ruleType === "skill" ? "skill" : "rule"
}

const FIELD_CLASS =
	"w-full rounded-xs border border-input-border bg-input-background px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"

/** Keys each kind shows as its own field; anything else is listed under Other fields and kept as is. */
const KNOWN_KEYS: Record<DocFileKind, string[]> = {
	skill: ["name", "description", "disabled", "enabled"],
	rule: ["paths", "disabled", "enabled"],
	workflow: ["disabled", "enabled"],
}

function baseName(filePath: string): string {
	return filePath.split(/[\\/]/).pop() ?? filePath
}

/** A skill's folder name, a rule's file name, or a workflow's /command. */
export function docTitle(target: DocFileTarget): string {
	const parts = target.path.split(/[\\/]/)
	if (target.kind === "skill") return (/^SKILL\.md$/i.test(parts.at(-1) ?? "") ? parts.at(-2) : parts.at(-1)) ?? target.path
	const name = baseName(target.path).replace(/\.(md|txt)$/i, "")
	return target.kind === "workflow" ? `/${name}` : name
}

function pathsOf(value: unknown): string {
	if (Array.isArray(value)) return value.map(String).join(", ")
	return typeof value === "string" ? value : ""
}

/**
 * A rule, workflow or skill in the doc editor, inside the Rules overlay:
 * front matter as fields (never YAML), the body with Preview / Edit. Back
 * returns to the list; the on/off switch stays on the list row.
 */
export function DocFileEditor({ target, onBack }: { target: DocFileTarget; onBack: () => void }) {
	const [doc, setDoc] = useState<{ body: string; fields: Record<string, unknown>; revision: string; readOnlyReason: string }>()
	const [fields, setFields] = useState<Record<string, unknown>>({})
	// The paths field as typed ("a, b,"), so the caret never jumps while it's parsed into a list.
	const [pathsText, setPathsText] = useState("")
	const [error, setError] = useState<string>()

	const load = useCallback(async () => {
		setError(undefined)
		try {
			const response = await DocServiceClient.readDoc(DocRequest.create({ path: target.path, kind: target.kind }))
			const parsed = JSON.parse(response.fieldsJson || "{}") as Record<string, unknown>
			setDoc({ body: response.body, fields: parsed, revision: response.revision, readOnlyReason: response.readOnlyReason })
			setFields(parsed)
			setPathsText(pathsOf(parsed.paths))
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		}
	}, [target.path, target.kind])

	useEffect(() => {
		void load()
	}, [load])

	const fieldsDirty = useMemo(() => JSON.stringify(fields) !== JSON.stringify(doc?.fields ?? {}), [fields, doc?.fields])
	const others = Object.entries(doc?.fields ?? {}).filter(([key]) => !KNOWN_KEYS[target.kind].includes(key))
	const set = (key: string, value: unknown) => setFields((current) => ({ ...current, [key]: value }))
	const openAsFile = () =>
		FileServiceClient.openFile(StringRequest.create({ value: target.path })).catch((error) =>
			setError(error instanceof Error ? error.message : String(error)),
		)

	return (
		<div className="flex flex-col gap-2 text-xs" data-testid="doc-file-editor">
			<div className="flex items-center gap-2">
				<Button onClick={onBack} size="xs" variant="secondary">
					<span aria-hidden className="codicon codicon-arrow-left text-[11px]!" />
					Back
				</Button>
				<h2 className="ph-no-capture m-0 min-w-0 flex-1 truncate text-[14px] font-semibold">{docTitle(target)}</h2>
				<Button onClick={() => void openAsFile()} size="xs" title="Open the file in an editor tab" variant="ghost">
					<span aria-hidden className="codicon codicon-go-to-file text-[11px]!" />
					Open as file
				</Button>
			</div>
			{error && (
				<InlineNotice
					actions={
						<Button onClick={() => void load()} size="xs" variant="secondary">
							Retry
						</Button>
					}
					tone="error">
					{error}
				</InlineNotice>
			)}
			{doc && (
				<DocEditor
					fields={
						<div className="grid gap-2" data-testid="doc-fields">
							{target.kind === "skill" && (
								<>
									<label className="block">
										<span className="mb-1 block text-[11px] text-description">Name</span>
										<input
											className={FIELD_CLASS}
											disabled={!!doc.readOnlyReason}
											onChange={(event) => set("name", event.target.value)}
											value={typeof fields.name === "string" ? fields.name : ""}
										/>
									</label>
									<label className="block">
										<span className="mb-1 block text-[11px] text-description">
											Description <span className="opacity-75">(decides when the skill loads)</span>
										</span>
										<textarea
											className={`${FIELD_CLASS} resize-y`}
											disabled={!!doc.readOnlyReason}
											onChange={(event) => set("description", event.target.value)}
											rows={2}
											value={typeof fields.description === "string" ? fields.description : ""}
										/>
									</label>
								</>
							)}
							{target.kind === "rule" && (
								<label className="block">
									<span className="mb-1 block text-[11px] text-description">
										Only when working on{" "}
										<span className="opacity-75">(paths, comma separated; empty means always)</span>
									</span>
									<input
										className={FIELD_CLASS}
										disabled={!!doc.readOnlyReason}
										onChange={(event) => {
											setPathsText(event.target.value)
											const paths = event.target.value
												.split(",")
												.map((entry) => entry.trim())
												.filter(Boolean)
											set("paths", paths.length ? paths : undefined)
										}}
										placeholder="src/**/*.test.ts, e2e/**"
										value={pathsText}
									/>
								</label>
							)}
							{others.length > 0 && (
								<details className="text-[11px] text-description">
									<summary className="cursor-pointer">Other fields · {others.length}</summary>
									<dl className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
										{others.map(([key, value]) => (
											<div className="contents" key={key}>
												<dt className="font-medium text-foreground">{key}</dt>
												<dd className="m-0 break-all">
													{typeof value === "string" ? value : JSON.stringify(value)}
												</dd>
											</div>
										))}
									</dl>
								</details>
							)}
							<div className="text-[11px] text-description">
								{target.isGlobal ? "Global" : "Workspace"} ·{" "}
								<span className="ph-no-capture break-all">{doc && target.path}</span>
							</div>
						</div>
					}
					fieldsDirty={fieldsDirty}
					key={doc.revision}
					label={`${docTitle(target)} body`}
					onDiscardFields={() => {
						setFields(doc.fields)
						setPathsText(pathsOf(doc.fields.paths))
					}}
					onSave={async (body) => {
						const response = await DocServiceClient.saveDoc(
							SaveDocRequest.create({
								path: target.path,
								kind: target.kind,
								body,
								fieldsJson: JSON.stringify(fields),
								baseRevision: doc.revision,
							}),
						)
						const parsed = JSON.parse(response.fieldsJson || "{}") as Record<string, unknown>
						setDoc({
							body: response.body,
							fields: parsed,
							revision: response.revision,
							readOnlyReason: response.readOnlyReason,
						})
						setFields(parsed)
						setPathsText(pathsOf(parsed.paths))
					}}
					readOnlyReason={doc.readOnlyReason || undefined}
					value={doc.body}
				/>
			)}
		</div>
	)
}
