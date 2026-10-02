import { describe, expect, it } from "bun:test"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { ServerConfigSchema } from "../schemas"
import { runMcpStartHook } from "../startHook"

function config(script: string, remote = false, timeout = 3) {
	return ServerConfigSchema.parse({
		...(remote
			? { type: "streamableHttp", url: "https://example.com/mcp", headers: { Existing: "yes" } }
			: { command: "server", env: { EXISTING: "yes" } }),
		startHook: { command: process.execPath, args: ["-e", script], timeout },
	})
}

describe("MCP start hooks", () => {
	it("parses flat and nested schemas and defaults the hook timeout", () => {
		for (const transport of [{ command: "server" }, { transport: { type: "stdio", command: "server" } }]) {
			const parsed = ServerConfigSchema.parse({ ...transport, startHook: { command: "bootstrap" } })
			expect(parsed.startHook?.timeout).toBe(60)
		}
		expect(ServerConfigSchema.safeParse({ command: "server", startHook: { command: "", timeout: -1 } }).success).toBe(false)
	})
	it("patches stdio env without mutating config or process.env", async () => {
		const input = config('console.log("ready"); console.log(JSON.stringify({env:{MCP_HOOK_TEST:"fresh"}}))')
		const result = await runMcpStartHook("test", input)
		expect(result).toMatchObject({ env: { EXISTING: "yes", MCP_HOOK_TEST: "fresh" } })
		expect(input).toMatchObject({ env: { EXISTING: "yes" } })
		expect(process.env.MCP_HOOK_TEST).toBeUndefined()
	})
	it("passes sanitized stdin and merges HTTP headers", async () => {
		const input = config(
			'let s=""; process.stdin.on("data", x=>s+=x); process.stdin.on("end",()=> {const i=JSON.parse(s); if(i.serverName!=="remote" || i.headers || i.env || i.transportType!=="streamableHttp") process.exit(1); console.log(JSON.stringify({headers:{Authorization:"Bearer fresh"}}))})',
			true,
		)
		const result = await runMcpStartHook("remote", input)
		expect(result).toMatchObject({ headers: { Existing: "yes", Authorization: "Bearer fresh" } })
		expect(input).toMatchObject({ headers: { Existing: "yes" } })
	})
	it("allows ordinary output and ignores invalid patches", async () => {
		const input = config('console.log("ordinary output")')
		expect(await runMcpStartHook("test", input)).toEqual(input)
		expect(await runMcpStartHook("test", config("console.log(JSON.stringify({env:{BAD:42}}))"))).not.toHaveProperty("env.BAD")
	})
	it("redacts malformed credential patches in logs and error tails", async () => {
		const log = sinon.stub(Logger, "log")
		try {
			const patch = JSON.stringify({ headers: { Authorization: "Bearer SECRET", Expires: 123 } })
			const input = config(`console.log(${JSON.stringify(patch)}); console.error(${JSON.stringify(patch)})`, true)
			expect(await runMcpStartHook("test", input)).toEqual(input)
			const output = log.args.flat().join("\n")
			expect(output).not.toContain("SECRET")
			expect(output).not.toContain("123")
			expect(output).toContain("headers.Expires: invalid_type")
			await expect(
				runMcpStartHook("test", config(`console.error(${JSON.stringify(patch)}); process.exit(2)`, true)),
			).rejects.toThrow("exit code 2:")
			expect(log.args.flat().join("\n")).not.toContain("SECRET")
		} finally {
			log.restore()
		}
	})

	it("redacts JSON on earlier lines and incomplete credential output", async () => {
		const log = sinon.stub(Logger, "log")
		try {
			await runMcpStartHook(
				"test",
				config(
					'console.log(JSON.stringify({env:{TOKEN:"SECRET"}})); console.log("headers: Authorization=SECRET"); console.log("ready")',
				),
			)
			expect(log.args.flat().join("\n")).not.toContain("SECRET")
			expect(log.args.flat().join("\n")).toContain("ready")
		} finally {
			log.restore()
		}
	})

	it("redacts values in multiline JSON error output", async () => {
		const log = sinon.stub(Logger, "log")
		try {
			let error: unknown
			try {
				await runMcpStartHook(
					"test",
					config('console.error(JSON.stringify({headers:{Custom:"sensitive-value"}},null,2)); process.exit(2)'),
				)
			} catch (caught) {
				error = caught
			}
			expect(error).toBeInstanceOf(Error)
			expect(String(error)).not.toContain("sensitive-value")
			expect(log.args.flat().join("\n")).not.toContain("sensitive-value")
		} finally {
			log.restore()
		}
	})

	it("redacts credential values while retaining their key names", async () => {
		const log = sinon.stub(Logger, "log")
		try {
			const lines = [
				"AWS_SECRET_ACCESS_KEY=aws-value",
				"GITHUB_TOKEN=github-value",
				"api_key=api-value",
				"Authorization: Bearer bearer-value",
				"bearer standalone-value",
				'{"env":{"AWS_SECRET_ACCESS_KEY":"json-value","invalid":42}}',
			]
			const script = `console.log(${JSON.stringify(lines.join("\n"))}); console.error(${JSON.stringify(lines.join("\n"))}); process.exit(2)`
			let error: unknown
			try {
				await runMcpStartHook("test", config(script))
			} catch (caught) {
				error = caught
			}
			const output = `${log.args.flat().join("\n")}\n${String(error)}`
			for (const value of [
				"aws-value",
				"github-value",
				"api-value",
				"bearer-value",
				"standalone-value",
				"json-value",
				"42",
			]) {
				expect(output).not.toContain(value)
			}
			for (const key of [
				"AWS_SECRET_ACCESS_KEY",
				"GITHUB_TOKEN",
				"api_key",
				"Authorization",
				"env.invalid: invalid_type",
			]) {
				expect(output).toContain(key)
			}
		} finally {
			log.restore()
		}
	})

	it("reports stderr on failure", async () => {
		await expect(
			runMcpStartHook("test", config('console.error("credential refresh failed"); process.exit(2)')),
		).rejects.toThrow("Start hook failed: exit code 2: credential refresh failed")
	})
	it("times out", async () => {
		await expect(
			runMcpStartHook("test", config('console.error("waiting"); setTimeout(()=>{},10000)', false, 0.05)),
		).rejects.toThrow("Start hook failed: timed out")
	})
})
