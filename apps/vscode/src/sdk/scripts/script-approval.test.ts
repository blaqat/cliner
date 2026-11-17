import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ScriptApproval } from "@shared/scripts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decideScriptApproval, readScriptToolInput, ScriptRunGrants, scriptApprovalDecision } from "./script-approval"
import { ScriptStore } from "./script-store"
import { scriptFingerprint } from "./script-trust"

describe("scriptApprovalDecision", () => {
	it.each([
		["always_ask", "plan", "ask"],
		["always_ask", "act", "ask"],
		["ask_in_ask_mode", "plan", "ask"],
		["ask_in_ask_mode", "act", "allow"],
		["always_allow", "plan", "allow"],
		["always_allow", "act", "allow"],
	] as const)("%s in %s mode: %s", (approval, mode, expected) => {
		expect(scriptApprovalDecision(approval, mode)).toBe(expected)
	})
})

describe("ScriptRunGrants", () => {
	it("covers one run of exactly those values in that thread", () => {
		let now = 1000
		const grants = new ScriptRunGrants(() => now)
		grants.grant("t1", "deploy", { env: "prod", dry: true }, "v1")
		expect(grants.consume("t2", "deploy", { env: "prod", dry: true }, "v1")).toBe(false)
		expect(grants.consume("t1", "deploy", { env: "dev", dry: true }, "v1")).toBe(false)
		expect(grants.consume("t1", "deploy", { dry: true, env: "prod" }, "v1")).toBe(true)
		expect(grants.consume("t1", "deploy", { env: "prod", dry: true }, "v1")).toBe(false)
		grants.grant("t1", "deploy", {}, "v1")
		expect(grants.consume("t1", "deploy", {}, "v2")).toBe("changed")
		grants.grant("t1", "deploy", {}, "v1")
		now += 11 * 60 * 1000
		expect(grants.consume("t1", "deploy", {}, "v1")).toBe(false)
	})
})

describe("readScriptToolInput", () => {
	it("reads object and JSON-string inputs and rejects the rest", () => {
		expect(readScriptToolInput({ action: "run", name: "x", options: { a: true } })).toEqual({
			action: "run",
			name: "x",
			options: { a: true },
		})
		expect(readScriptToolInput('{"action":"load","name":"x"}')).toEqual({ action: "load", name: "x", options: undefined })
		expect(readScriptToolInput({ action: "delete", name: "x" })).toBeUndefined()
		expect(readScriptToolInput("not json")).toBeUndefined()
	})
})

describe("decideScriptApproval", () => {
	let root: string
	let store: ScriptStore
	let grants: ScriptRunGrants
	const write = (name: string, approval?: ScriptApproval) =>
		fs.writeFile(
			path.join(root, `${name}.md`),
			`---\ndescription: d\ncommand: echo {{who}}\n${approval ? `approval: ${approval}\n` : ""}options:\n  - {name: who, kind: text, required: true}\n---\n`,
		)

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-script-approval-"))
		store = new ScriptStore({
			getGlobalDir: () => root,
			getWorkspaceRoot: () => undefined,
			getToggles: () => ({ global: {}, workspace: {} }),
		})
		grants = new ScriptRunGrants()
		await write("default-level")
		await write("ask-always", "always_ask")
		await write("allow-always", "always_allow")
		for (const script of await store.listEnabled()) await store.trust.trust(script)
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	const decide = (name: string, mode: "plan" | "act", options: Record<string, unknown> = { who: "me" }, action = "run") =>
		decideScriptApproval({ store, grants }, { action, name, options }, mode, "thread-1")

	it("defaults to asking in Ask mode and allowing in Act mode", async () => {
		expect(await decide("default-level", "plan")).toBe("ask")
		expect(await decide("default-level", "act")).toBe("allow")
	})

	it("always ask asks in both modes; always allow allows in both", async () => {
		expect(await decide("ask-always", "plan")).toBe("ask")
		expect(await decide("ask-always", "act")).toBe("ask")
		expect(await decide("allow-always", "plan")).toBe("allow")
		expect(await decide("allow-always", "act")).toBe("allow")
	})

	it.each(["/ask-always", " ask-always "])("normalizes %s before checking approval", async (name) => {
		expect(await decide(name, "act")).toBe("ask")
	})

	it("never asks to load notes", async () => {
		expect(await decide("ask-always", "plan", {}, "load")).toBe("allow")
	})

	it("rejects unknown scripts and invalid runs", async () => {
		expect(await decide("ask-always", "plan", {})).toBe("reject") // required option missing
		expect(await decide("ask-always", "plan", { who: "x", extra: "y" })).toBe("reject")
		expect(await decide("no-such-script", "plan")).toBe("reject")
	})

	it("treats the user's typed run as approval for that one run, at any level", async () => {
		grants.grant("thread-1", "ask-always", { who: "me" }, scriptFingerprint((await store.find("ask-always"))!))
		expect(await decide("ask-always", "plan")).toBe("allow")
		expect(await decide("ask-always", "plan")).toBe("ask")
		grants.grant("thread-1", "ask-always", { who: "me" }, scriptFingerprint((await store.find("ask-always"))!))
		expect(await decide("ask-always", "plan", { who: "someone else" })).toBe("ask")
	})
})
