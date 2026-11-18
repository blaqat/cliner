import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ticketToPr } from "./automation-fixtures"
import { AutomationsHost } from "./automation-host"

describe("AutomationsHost.start", () => {
	let root: string
	let started: string[]
	const makeHost = () =>
		new AutomationsHost({
			getWorkspaceRoot: () => path.join(root, "repo"),
			getStorageDir: () => path.join(root, "storage"),
			findOrCreateTask: async (ticket) => `group-${ticket}`,
			createTask: async () => "group-new",
			startThread: async (input) => {
				started.push(input.title)
				return `thread-${started.length}`
			},
			stopThread: async () => {},
			onRunsChanged: () => {},
		})

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-automation-host-"))
		started = []
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("runs only the trusted version the start form showed", async () => {
		const host = makeHost()
		const saved = await host.store.save(ticketToPr(), "workspace")
		await expect(host.start("ticket-to-pr", { ticket: "P-1" }, { fingerprint: "old" })).rejects.toThrow(
			"changed since the start form opened",
		)
		await fs.writeFile(saved.filePath, saved.content.replace("Read {{ticket}}", "Read {{ticket}} now"))
		const changed = await host.store.findByPath(saved.filePath)
		await expect(host.start("ticket-to-pr", { ticket: "P-1" }, { fingerprint: changed?.fingerprint ?? "" })).rejects.toThrow(
			"changed since you last trusted it",
		)
		await host.store.trustVersion(saved.filePath, changed?.fingerprint ?? "")
		const run = await host.start("ticket-to-pr", { ticket: "P-1" }, { fingerprint: changed?.fingerprint ?? "" })
		expect(run.automation).toBe("ticket-to-pr")
		await expect(host.start("nope", {}, { fingerprint: "" })).rejects.toThrow("no automation called nope")
		// The run persists asynchronously; finish its writes before afterEach removes storage.
		await host.flushed()
	})

	it("keeps runs in extension storage across restarts", async () => {
		const host = makeHost()
		const saved = await host.store.save(ticketToPr(), "workspace")
		await host.start("ticket-to-pr", { ticket: "P-2" }, { fingerprint: saved.fingerprint })
		await new Promise((resolve) => setTimeout(resolve, 0))
		await host.flushed()
		const again = makeHost()
		await again.runner.load()
		expect(again.runner.list()).toHaveLength(1)
		expect(again.runner.list()[0]).toMatchObject({ automation: "ticket-to-pr", status: "stopped" })
	})
})
