import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { serializeAutomation } from "./automation-file"
import { ticketToPr } from "./automation-fixtures"
import { AutomationStore, WORKSPACE_AUTOMATIONS_DIR } from "./automation-store"

describe("AutomationStore", () => {
	let root: string
	let globalDir: string
	let workspace: string
	const makeStore = () =>
		new AutomationStore({
			getGlobalDir: () => globalDir,
			getWorkspaceRoot: () => workspace,
			getTrustFile: () => path.join(root, "storage", "automation-trust.json"),
		})

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-automations-"))
		globalDir = path.join(root, "home", ".cline", "automations")
		workspace = path.join(root, "repo")
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("saves to the workspace folder, trusts what it wrote, and reads it back", async () => {
		const store = makeStore()
		const saved = await store.save(ticketToPr(), "workspace")
		expect(saved.filePath).toBe(path.join(workspace, WORKSPACE_AUTOMATIONS_DIR, "ticket-to-pr.md"))
		expect(saved.trusted).toBe(true)
		expect(saved.definition).toEqual(ticketToPr())
		expect((await store.find("ticket-to-pr"))?.scope).toBe("workspace")
	})

	it("asks for trust again when someone else changes a file", async () => {
		const store = makeStore()
		const saved = await store.save(ticketToPr(), "workspace")
		await fs.writeFile(saved.filePath, saved.content.replace("Read {{ticket}}", "Read {{ticket}} carefully"))
		const changed = await store.findByPath(saved.filePath)
		expect(changed?.trusted).toBe(false)
		await expect(store.trustVersion(saved.filePath, saved.fingerprint)).rejects.toThrow("changed since you looked")
		await store.trustVersion(saved.filePath, changed?.fingerprint ?? "")
		expect((await store.findByPath(saved.filePath))?.trusted).toBe(true)
	})

	it("keeps the file the user reviewed and rejects stale proposals", async () => {
		const store = makeStore()
		const original = await store.save(ticketToPr(), "workspace")
		const proposed = original.content.replace("Read {{ticket}}", "Read {{ticket}} carefully")
		const kept = await store.saveProposal(original.filePath, original.fingerprint, proposed)
		expect(kept.content).toBe(proposed)
		expect(kept.trusted).toBe(true)
		await expect(store.saveProposal(original.filePath, original.fingerprint, original.content)).rejects.toThrow(
			"changed on disk",
		)
		expect(await fs.readFile(original.filePath, "utf8")).toBe(proposed)
	})

	it("lists workspace before global, and a workspace automation shadows a global one", async () => {
		await fs.mkdir(globalDir, { recursive: true })
		await fs.writeFile(path.join(globalDir, "ticket-to-pr.md"), serializeAutomation(ticketToPr()))
		await fs.writeFile(path.join(globalDir, "broken.md"), "nope")
		const store = makeStore()
		expect((await store.find("ticket-to-pr"))?.scope).toBe("global")
		await store.save(ticketToPr(), "workspace")
		const all = await store.list()
		expect(all.map((item) => [item.scope, item.name, item.errors.length > 0])).toEqual([
			["workspace", "ticket-to-pr", false],
			["global", "broken", true],
			["global", "ticket-to-pr", false],
		])
		expect((await store.find("ticket-to-pr"))?.scope).toBe("workspace")
	})

	it("renaming moves the file, and a name clash is refused", async () => {
		const store = makeStore()
		const first = await store.save(ticketToPr(), "global")
		const renamed = await store.save({ ...ticketToPr(), name: "ship-it" }, "global", first.filePath)
		expect(path.basename(renamed.filePath)).toBe("ship-it.md")
		expect((await store.list()).map((item) => item.name)).toEqual(["ship-it"])
		await store.save(ticketToPr(), "global")
		await expect(
			store.save({ ...ticketToPr(), name: "ship-it" }, "global", path.join(globalDir, "ticket-to-pr.md")),
		).rejects.toThrow("already exists")
	})

	it("refuses to save an invalid definition or delete a file it doesn't list", async () => {
		const store = makeStore()
		await expect(store.save({ ...ticketToPr(), description: "" }, "global")).rejects.toThrow("Add a description")
		await expect(store.remove(path.join(root, "elsewhere.md"))).rejects.toThrow("Only automation files")
	})
})
