import type { ClineMessage } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { AskResponseRequest } from "@shared/proto/cline/task"
import { useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { FileServiceClient, TaskServiceClient } from "@/services/grpc-client"

/**
 * Row for the `script` tool: the script's name and the option values it runs with, then the outcome
 * once it has run. Unreviewed definitions show the saved command and cwd before the user approves.
 */
export interface ScriptToolInfo {
	action: "load" | "run"
	name: string
	options: [string, string | boolean][]
	/** The tool's result text: status line, output tail and log path. */
	command?: string
	cwd?: string
	outcome?: string
}

export function parseScriptTool(tool: unknown): ScriptToolInfo | null {
	if (!tool || typeof tool !== "object") return null
	const record = tool as Record<string, unknown>
	if (record.tool !== "script") return null
	const options =
		record.scriptOptions && typeof record.scriptOptions === "object" && !Array.isArray(record.scriptOptions)
			? Object.entries(record.scriptOptions as Record<string, unknown>).filter(
					(entry): entry is [string, string | boolean] => typeof entry[1] === "string" || typeof entry[1] === "boolean",
				)
			: []
	return {
		action: record.scriptAction === "load" ? "load" : "run",
		name: typeof record.name === "string" ? record.name : "",
		options,
		command: typeof record.scriptCommand === "string" ? record.scriptCommand : undefined,
		cwd: typeof record.scriptCwd === "string" ? record.scriptCwd : undefined,
		outcome: typeof record.content === "string" && record.content ? record.content : undefined,
	}
}

export interface ScriptOutcome {
	ok: boolean
	/** e.g. "succeeded (exit code 0)" */
	status: string
	output: string
	logPath?: string
}

/** Reads the status line, output tail and log path out of the tool's result text. */
export function parseScriptOutcome(text: string): ScriptOutcome {
	if (text.startsWith("Error: ")) return { ok: false, status: text.slice("Error: ".length), output: "" }
	const [statusLine = "", ...rest] = text.split("\n")
	const status = /^Script ".*" (.*)\.$/.exec(statusLine)?.[1] ?? statusLine
	const logIndex = rest.findIndex((line) => line.startsWith("Full log: "))
	const logLine = logIndex >= 0 ? rest[logIndex] : undefined
	const logPath = logLine?.slice("Full log: ".length).replace(/ \(read it for earlier output\)$/, "")
	const body = rest.slice(
		rest[0]?.startsWith("Output") || rest[0] === "No output." ? 1 : 0,
		logIndex >= 0 ? logIndex : undefined,
	)
	return { ok: status.startsWith("succeeded"), status, output: body.join("\n"), logPath }
}

export function ScriptToolRow({ info, asking, message }: { info: ScriptToolInfo; asking: boolean; message?: ClineMessage }) {
	const { currentTaskItem, pendingSubagentDecisions, turnState } = useExtensionState()
	const [sending, setSending] = useState(false)
	const [error, setError] = useState("")
	const active =
		!!message?.decisionId &&
		(turnState?.anchorTs === message.ts ||
			pendingSubagentDecisions?.some((item) => item.message.decisionId === message.decisionId))
	const respond = async (trust: boolean) => {
		if (!currentTaskItem || !message?.decisionId) return
		setSending(true)
		try {
			await TaskServiceClient.askResponse(
				AskResponseRequest.create({
					taskId: currentTaskItem.id,
					decisionId: message.decisionId,
					responseType: "yesButtonClicked",
					text: trust ? "trust-script-version" : undefined,
				}),
			)
		} catch {
			setError("Couldn't send approval. Try again.")
		} finally {
			setSending(false)
		}
	}
	const [showOutput, setShowOutput] = useState(false)
	const outcome = info.outcome ? parseScriptOutcome(info.outcome) : undefined
	const verb =
		info.action === "load"
			? asking
				? "Cline wants to read the script notes:"
				: "Cline read the script notes:"
			: asking
				? "Cline wants to run the script:"
				: "Cline ran the script:"
	return (
		<div data-testid="script-tool-row">
			<div className="mb-3 flex items-center gap-2.5">
				<span aria-hidden className="codicon codicon-play" />
				<span className="font-bold">{verb}</span>
			</div>
			<div className="rounded-xs border border-editor-group-border bg-code px-2.5 py-[9px]">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="ph-no-capture font-mono font-medium">{info.name}</span>
					{info.options.map(([name, value]) => (
						<span
							className="inline-flex items-center gap-1 rounded-full border border-solid border-editor-group-border px-1.5 text-[11px] leading-4"
							key={name}>
							<span className="text-description">{name}</span>
							{value !== true && <span className="ph-no-capture">{String(value)}</span>}
						</span>
					))}
				</div>
				{asking && info.command && (
					<InlineNotice className="mt-2" tone="warning">
						<div className="font-medium">Unreviewed script</div>
						<pre className="ph-no-capture m-0 my-1 whitespace-pre-wrap font-mono text-[11px]">{info.command}</pre>
						<div className="text-description">Runs in: {info.cwd}</div>
						{active && (
							<div className="mt-2 flex gap-1.5">
								<Button disabled={sending} onClick={() => void respond(false)} size="xs" variant="secondary">
									Run once
								</Button>
								<Button disabled={sending} onClick={() => void respond(true)} size="xs" variant="secondary">
									Trust this version
								</Button>
							</div>
						)}
						{error && (
							<div className="mt-1 text-error" role="alert">
								{error}
							</div>
						)}
					</InlineNotice>
				)}
				{outcome && (
					<div className="mt-1.5 text-xs" data-testid="script-outcome">
						<div className="flex items-center gap-2">
							<span className={cn("flex items-center gap-1", outcome.ok ? "text-success" : "text-error")}>
								<span aria-hidden className={cn("codicon", outcome.ok ? "codicon-check" : "codicon-error")} />
								{outcome.status}
							</span>
							{outcome.output && (
								<LinkButton aria-expanded={showOutput} onClick={() => setShowOutput((shown) => !shown)}>
									{showOutput ? "Hide output" : "Show output"}
								</LinkButton>
							)}
							{outcome.logPath && (
								<LinkButton
									onClick={() =>
										FileServiceClient.openFile(StringRequest.create({ value: outcome.logPath })).catch(
											(err) => console.error("Failed to open script log:", err),
										)
									}>
									Open log
								</LinkButton>
							)}
						</div>
						{showOutput && outcome.output && (
							<pre className="m-0 mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
								{outcome.output}
							</pre>
						)}
					</div>
				)}
			</div>
		</div>
	)
}
