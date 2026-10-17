import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"

/**
 * Row for the `script` tool: the script's name and the option values it runs with, then the outcome
 * once it has run. The saved command is never shown here; the approval prompt is about the script,
 * not a shell string.
 */
export interface ScriptToolInfo {
	action: "load" | "run"
	name: string
	options: [string, string | boolean][]
	/** The tool's result text: status line, output tail and log path. */
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

export function ScriptToolRow({ info, asking }: { info: ScriptToolInfo; asking: boolean }) {
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
							className="inline-flex items-center gap-1 rounded-full border border-editor-group-border px-1.5 text-[11px] leading-4"
							key={name}>
							<span className="text-description">{name}</span>
							{value !== true && <span className="ph-no-capture">{String(value)}</span>}
						</span>
					))}
				</div>
				{outcome && (
					<div className="mt-1.5 text-xs" data-testid="script-outcome">
						<div className="flex items-center gap-2">
							<span
								className={cn(
									"flex items-center gap-1",
									outcome.ok ? "text-(--vscode-charts-green)" : "text-(--vscode-errorForeground)",
								)}>
								<span aria-hidden className={cn("codicon", outcome.ok ? "codicon-check" : "codicon-error")} />
								{outcome.status}
							</span>
							{outcome.output && (
								<button
									aria-expanded={showOutput}
									className="cursor-pointer border-0 bg-transparent p-0 text-(--vscode-textLink-foreground) hover:underline"
									onClick={() => setShowOutput((shown) => !shown)}
									type="button">
									{showOutput ? "Hide output" : "Show output"}
								</button>
							)}
							{outcome.logPath && (
								<button
									className="cursor-pointer border-0 bg-transparent p-0 text-(--vscode-textLink-foreground) hover:underline"
									onClick={() =>
										FileServiceClient.openFile(StringRequest.create({ value: outcome.logPath })).catch(
											(err) => console.error("Failed to open script log:", err),
										)
									}
									type="button">
									Open log
								</button>
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
