import { execa } from "execa"
import { z } from "zod"
import { Logger } from "@/shared/services/Logger"
import type { McpServerConfig } from "./types"

const PatchSchema = z.object({
	env: z.record(z.string(), z.string()).optional(),
	headers: z.record(z.string(), z.string()).optional(),
})

// JSON patches can contain credentials in arbitrary env/header fields.
function redactHookOutput(output: string): string {
	const redactJson = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(redactJson)
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactJson(entry)]))
		}
		return "[REDACTED]"
	}
	return output
		.split(/\r?\n/)
		.map((line) => {
			try {
				return JSON.stringify(redactJson(JSON.parse(line)))
			} catch {
				return line
					.replace(/(\bauthorization\s*[:=]\s*)[^\r\n,}]+/gi, "$1[REDACTED]")
					.replace(/\bBearer\s+[^\s"',;}]+/gi, "Bearer [REDACTED]")
					.replace(/("[^"\n]+"\s*:\s*)("(?:\\.|[^"\\])*"|[^,}\n]+)/g, '$1"[REDACTED]"')
					.replace(
						/([\w.-]*(?:secret|token|password|passwd|pwd|key|auth|credential|cookie|session|bearer)[\w.-]*\s*[=:]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
						"$1[REDACTED]",
					)
			}
		})
		.join("\n")
}

/** Run on a private expanded config. Bootstrap credentials never enter settings or process.env. */
export async function runMcpStartHook(
	serverName: string,
	config: McpServerConfig,
	cancelSignal?: AbortSignal,
): Promise<McpServerConfig> {
	const hook = config.startHook
	if (!hook) return config
	const input = JSON.stringify({
		serverName,
		transportType: config.type,
		...(config.type === "stdio" ? { command: config.command, args: config.args } : { url: config.url }),
	})
	try {
		// execa uses cross-spawn, as the MCP stdio transport does, including Windows command resolution.
		const result = await execa(hook.command, hook.args ?? [], {
			cancelSignal,
			cwd: hook.cwd,
			env: { ...process.env, ...hook.env },
			input,
			timeout: (hook.timeout ?? 60) * 1000,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
			forceKillAfterDelay: 100,
			reject: false,
		})
		const stdout = String(result.stdout)
		const stderr = redactHookOutput(String(result.stderr)).trim().slice(-4096)
		const lines = stdout.trimEnd().split(/\r?\n/)
		let patch: z.infer<typeof PatchSchema> | undefined
		try {
			const parsed = PatchSchema.safeParse(JSON.parse(lines.at(-1) ?? ""))
			if (parsed.success) patch = parsed.data
			else
				Logger.log(
					`[MCP start hook ${serverName}] Invalid credential patch: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}${issue.code === "invalid_type" ? ` (expected ${issue.expected})` : ""}`).join(", ")}`,
				)
		} catch {
			// Ordinary stdout is allowed; only the final line can supply a patch.
		}
		const log = redactHookOutput((patch ? lines.slice(0, -1) : lines).join("\n"))
		if (log) Logger.log(`[MCP start hook ${serverName}] ${log}`)
		if (stderr) Logger.log(`[MCP start hook ${serverName}] ${stderr}`)
		if (result.timedOut || result.exitCode !== 0) {
			throw new Error(
				`${result.timedOut ? "timed out" : `exit code ${result.exitCode ?? result.signal}`}${stderr ? `: ${stderr}` : ""}`,
			)
		}
		return {
			...config,
			...(patch?.env && config.type === "stdio" ? { env: { ...config.env, ...patch.env } } : {}),
			...(patch?.headers && config.type !== "stdio" ? { headers: { ...config.headers, ...patch.headers } } : {}),
		}
	} catch (error) {
		throw new Error(`Start hook failed: ${redactHookOutput(error instanceof Error ? error.message : String(error))}`)
	}
}
