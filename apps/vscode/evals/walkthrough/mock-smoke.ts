#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** Exercise the manual runner through a local OpenAI-compatible server. No model calls or real settings. */
const directory = await mkdtemp(path.join(tmpdir(), "walkthrough-eval-smoke-"))
let requests = 0
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		requests++
		const body = (await request.json()) as {
			messages: { role: string; content: string | { type: string; text: string }[] }[]
		}
		const content = body.messages.filter((m) => m.role === "user").at(-1)?.content
		const text =
			typeof content === "string"
				? content
				: (content
						?.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("") ?? "")
		const digest = JSON.parse(text) as { hunks: { id: string }[] }
		const args = {
			title: "Review changed behavior",
			focus: "Timeout cancel duplicate submission cache fingerprint notes thread hunk.",
			chapters: [
				{
					title: "Runtime",
					stops: [
						{
							title: "Review changed behavior",
							prose: "Read the changed runtime behavior.",
							hunkIds: digest.hunks.slice(0, 14).map((h) => h.id),
						},
					],
				},
			],
			support: digest.hunks.slice(14).map((h) => h.id),
		}
		const delta = {
			id: "fixture",
			object: "chat.completion.chunk",
			created: 1,
			model: "fixture-model",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "submit",
								type: "function",
								function: { name: "submit_walkthrough", arguments: JSON.stringify(args) },
							},
						],
					},
					finish_reason: null,
				},
			],
		}
		const finish = { ...delta, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
		return new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		})
	},
})
try {
	const config = path.join(directory, "profiles.json")
	const report = path.join(directory, "report.json")
	await writeFile(
		config,
		JSON.stringify({
			profiles: [
				{
					id: "fixture",
					name: "Fixture",
					provider: "openai",
					modelId: "fixture-model",
					options: { openAiBaseUrl: `http://127.0.0.1:${server.port}/v1` },
				},
			],
			secrets: { fixture: { openAiApiKey: "test-only" } },
		}),
	)
	const child = Bun.spawn(["bun", "evals/walkthrough/run.ts", "--config", config, "--profile", "fixture", "--output", report], {
		cwd: path.resolve(import.meta.dir, "../.."),
		env: { ...process.env, CLINE_DIR: directory, CLINE_DATA_DIR: path.join(directory, "data") },
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	if (code !== 0) throw new Error(`Eval runner failed (${code}):\n${stdout}\n${stderr}`)
	const results = JSON.parse(await readFile(report, "utf8")) as { id: string; score: number }[]
	if (requests !== 4 || results.length !== 4 || results.some((r) => r.score !== 100))
		throw new Error(`Unexpected eval result: ${requests} requests, ${JSON.stringify(results)}`)
	console.log("4 fixtures passed through the real profile resolver and provider handler using 4 mocked HTTP requests.")
} finally {
	server.stop(true)
	await rm(directory, { recursive: true, force: true })
}
