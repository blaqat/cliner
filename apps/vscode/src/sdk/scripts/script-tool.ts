import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { type AgentTool, createTool } from "@cline/shared"
import { formatTypedOptions, SCRIPT_APPROVAL_LABELS } from "@shared/scripts"
import { resolveScriptRun } from "./script-command"
import type { ScriptDefinition } from "./script-file"
import { runScriptCommand, SCRIPT_OUTPUT_TAIL_LINES, type ScriptRunResult } from "./script-runner"
import type { ScriptStore } from "./script-store"

export interface ScriptToolContext {
	store: ScriptStore
	/** Where a script without its own `cwd` runs. */
	getWorkspaceRoot: () => string
	/** Full environment for a command run in `cwd`: the configured terminal environment. */
	resolveEnv: (cwd: string) => Promise<Record<string, string>>
	/** Extension storage folder for full output logs. */
	logDir: string
	platform?: NodeJS.Platform
	/** Replaceable for tests. */
	run?: typeof runScriptCommand
}

const MAX_LOGS = 50
const MAX_INDEX_SCRIPTS = 40

interface ScriptToolInput {
	action: "load" | "run"
	name: string
	options?: Record<string, string | boolean>
}

function describeOption(option: ScriptDefinition["options"][number]): string {
	const parts = [option.kind, option.required ? "required" : "optional"]
	if (option.choices?.length) parts.push(`one of: ${option.choices.join(", ")}`)
	else if (option.kind === "choice") parts.push("no choices available")
	if (option.default !== undefined) parts.push(`default: ${String(option.default)}`)
	return `- ${option.name} (${parts.join("; ")})${option.description ? `: ${option.description}` : ""}`
}

/** Full usage notes returned by `load`. */
export function describeScript(script: ScriptDefinition): string {
	const lines = [
		`Script: ${script.name}`,
		`Use when: ${script.description}`,
		`File: ${script.filePath}`,
		`Approval: ${SCRIPT_APPROVAL_LABELS[script.approval]}`,
		`Command: ${script.command}`,
	]
	if (script.cwd) lines.push(`Runs in: ${script.cwd}`)
	lines.push(
		script.options.length
			? `Options (pass them in "options" when running):\n${script.options.map(describeOption).join("\n")}`
			: "Options: none",
	)
	if (script.notes) lines.push(`\nUsage notes:\n${script.notes}`)
	return lines.join("\n")
}

async function resolveCwd(script: ScriptDefinition, workspaceRoot: string): Promise<string> {
	let cwd = script.cwd?.trim()
	if (!cwd) return workspaceRoot
	if (cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("~\\")) cwd = path.join(os.homedir(), cwd.slice(1))
	const resolved = path.resolve(workspaceRoot, cwd)
	const stat = await fs.stat(resolved).catch(() => undefined)
	if (!stat?.isDirectory()) throw new Error(`The script's cwd does not exist: ${resolved}`)
	return resolved
}

async function pruneLogs(logDir: string): Promise<void> {
	try {
		const names = (await fs.readdir(logDir)).filter((name) => name.endsWith(".log")).sort()
		for (const name of names.slice(0, Math.max(0, names.length - MAX_LOGS))) {
			await fs.rm(path.join(logDir, name), { force: true })
		}
	} catch {
		// Pruning is best effort.
	}
}

function formatRunResult(script: ScriptDefinition, result: ScriptRunResult, tailLines: number): string {
	const status = result.aborted
		? "was cancelled"
		: result.timedOut
			? "timed out and was stopped"
			: result.signal
				? `was stopped by ${result.signal}`
				: result.exitCode === 0
					? "succeeded (exit code 0)"
					: `failed (exit code ${result.exitCode ?? "unknown"})`
	const shown = Math.min(result.totalLines, tailLines)
	const heading =
		result.totalLines === 0
			? "No output."
			: result.totalLines > tailLines
				? `Output (last ${shown} of ${result.totalLines} lines):`
				: `Output (${result.totalLines} line${result.totalLines === 1 ? "" : "s"}):`
	return [
		`Script "${script.name}" ${status}.`,
		heading,
		...(result.tail ? [result.tail] : []),
		`Full log: ${result.logPath}${result.totalLines > tailLines ? " (read it for earlier output)" : ""}`,
	].join("\n")
}

export function buildScriptIndex(scripts: readonly ScriptDefinition[]): string {
	if (scripts.length === 0) return "No scripts are enabled."
	const lines = scripts.slice(0, MAX_INDEX_SCRIPTS).map((script) => `- ${script.name}: ${script.description}`)
	if (scripts.length > MAX_INDEX_SCRIPTS) lines.push(`${scripts.length - MAX_INDEX_SCRIPTS} more; load by name`)
	return lines.join("\n")
}

/**
 * The `script` tool: loads a saved script's notes, or runs its exact saved
 * command with validated option values. There is no free-form shell here; the
 * approval prompt and the "always allow" level apply to the script by name.
 */
export function createScriptTool(context: ScriptToolContext): AgentTool {
	const baseDescription =
		"Load or run the user's saved scripts. Scripts are fixed commands with declared options; you cannot change the command. " +
		'Use action "load" to read a script\'s usage notes and options before running it, and action "run" with "options" ' +
		"(option name to value; flags are true) to run it. A run returns the exit code and the tail of the output; the full log path is included. " +
		"Some scripts ask the user for approval first."
	const tool = createTool<ScriptToolInput, string | { error: string }>({
		name: "script",
		description: baseDescription,
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["load", "run"] },
				name: { type: "string", description: "Script name from the list" },
				options: {
					type: "object",
					description: "Option values by option name; flags are true. Only declared options are accepted.",
					additionalProperties: { type: ["string", "boolean"] },
				},
			},
			required: ["action", "name"],
		},
		retryable: false,
		executionMode: "sequential",
		execute: async (input, toolContext) => {
			try {
				if (input?.action !== "load" && input?.action !== "run") return { error: 'action must be "load" or "run".' }
				const name = typeof input.name === "string" ? input.name.trim().replace(/^\//, "") : ""
				const script = await context.store.find(name)
				if (!script) {
					const known = (await context.store.listEnabled()).map((entry) => entry.name).join(", ") || "none"
					return { error: `No enabled script named "${name}". Enabled scripts: ${known}.` }
				}
				if (input.action === "load") return describeScript(script)

				const resolved = resolveScriptRun(script, input.options, context.platform)
				if (!resolved.ok) return { error: resolved.error }
				const cwd = await resolveCwd(script, context.getWorkspaceRoot())
				const env = await context.resolveEnv(cwd)
				const stamp = new Date().toISOString().replace(/[:.]/g, "-")
				const logPath = path.join(context.logDir, `${stamp}-${script.name}.log`)
				const result = await (context.run ?? runScriptCommand)({
					command: resolved.command,
					cwd,
					env,
					logPath,
					signal: toolContext?.signal,
				})
				void pruneLogs(context.logDir)
				return formatRunResult(script, result, SCRIPT_OUTPUT_TAIL_LINES)
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})
	// The index is read each time the tool list is sent, so scripts the user adds or
	// toggles show up without restarting the thread.
	Object.defineProperty(tool, "description", {
		get() {
			return `${baseDescription}\n\nEnabled scripts:\n${buildScriptIndex(context.store.peekEnabled())}`
		},
		enumerable: true,
		configurable: true,
	})
	return tool as AgentTool
}

/** The instruction a composer-typed script becomes: run exactly this, already approved by the user. */
export function buildScriptInvocationInstruction(
	script: ScriptDefinition,
	values: Record<string, string | boolean>,
	note: string,
): string {
	const typed = formatTypedOptions(script.options, values)
	const lines = [
		`The user ran the saved script "${script.name}"${typed ? ` with: ${typed}` : " with no options"}.`,
		`Run it now with the script tool, using exactly these values and no others: ${JSON.stringify({ action: "run", name: script.name, options: values })}.`,
		"The user asked for this run explicitly, so it needs no further approval. Do not run it with different options or run other scripts for this request.",
		"Then report the outcome briefly.",
	]
	if (note) lines.push(`\nNote from the user: ${note}`)
	return lines.join("\n")
}
