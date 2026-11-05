import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClineFileStorage } from "../ClineFileStorage"
import { createStorageContext } from "../storage-context"

describe("createStorageContext beside the Marketplace extension", () => {
	let clineDir: string
	let shared: string
	let own: string

	const write = (file: string, value: object) => {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, JSON.stringify(value))
	}
	const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"))
	const open = (extra: { stateNamespace?: string; workspacePath?: string } = {}) =>
		createStorageContext({ clineDir, stateNamespace: "cliner", workspacePath: "/repo", ...extra })

	beforeEach(() => {
		clineDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-context-"))
		shared = path.join(clineDir, "data")
		own = path.join(shared, "cliner")
	})
	afterEach(() => fs.rmSync(clineDir, { recursive: true, force: true }))

	it("starts from the shared files once, so an upgrade keeps the setup", () => {
		write(path.join(shared, "globalState.json"), { modelSettings: { revision: 4 } })
		write(path.join(shared, "secrets.json"), { apiKey: "sk-1" })
		const storage = open()
		expect(storage.stateDir).toBe(own)
		expect(storage.globalState.get<unknown>("modelSettings")).toEqual({ revision: 4 })
		expect(storage.secrets.get<unknown>("apiKey")).toBe("sk-1")
	})

	it("brings a workspace's state over the first time that workspace opens", async () => {
		const marketplace = createStorageContext({ clineDir, stateNamespace: undefined, workspacePath: "/two" })
		await marketplace.workspaceState.update("toggle", 1)
		expect(open({ workspacePath: "/two" }).workspaceState.get<unknown>("toggle")).toBe(1)
	})

	it("is out of reach of another extension writing back its whole old copy of the shared file", async () => {
		write(path.join(shared, "globalState.json"), { modelSettings: { revision: 1 } })
		// The other extension loaded the file before we changed anything.
		const other = new ClineFileStorage(path.join(shared, "globalState.json"), "Other")
		const storage = open()
		await storage.globalStateBackingStore.setBatch({ modelSettings: { revision: 2 } })
		await other.setBatch({ somethingElse: true })
		expect(open().globalState.get<unknown>("modelSettings")).toEqual({ revision: 2 })
	})

	it("never replaces its own copy with the shared one again", async () => {
		write(path.join(shared, "globalState.json"), { modelSettings: { revision: 1 } })
		await open().globalStateBackingStore.setBatch({ modelSettings: { revision: 2 } })
		write(path.join(shared, "globalState.json"), { modelSettings: { revision: 9 } })
		expect(open().globalState.get<unknown>("modelSettings")).toEqual({ revision: 2 })
		expect(read(path.join(shared, "globalState.json")).modelSettings).toEqual({ revision: 9 })
	})

	it("never changes the shared files", async () => {
		const before = { modelSettings: { revision: 1 } }
		write(path.join(shared, "globalState.json"), before)
		await open().globalStateBackingStore.setBatch({ modelSettings: { revision: 2 } })
		expect(read(path.join(shared, "globalState.json"))).toEqual(before)
	})

	it("keeps secrets private when it copies them", async () => {
		if (process.platform === "win32") return
		fs.mkdirSync(shared, { recursive: true })
		// The shared file may be looser than it should be; the copy isn't.
		fs.writeFileSync(path.join(shared, "secrets.json"), JSON.stringify({ apiKey: "sk-1" }), { mode: 0o644 })
		open()
		expect(fs.statSync(path.join(own, "secrets.json")).mode & 0o777).toBe(0o600)
		await open().secrets.setBatch({ other: "x" })
		expect(fs.statSync(path.join(own, "secrets.json")).mode & 0o777).toBe(0o600)
	})

	it("a drive without hard links still gets its copy", () => {
		write(path.join(shared, "globalState.json"), { modelSettings: { revision: 1 } })
		const link = spyOn(fs, "linkSync").mockImplementation(() => {
			throw Object.assign(new Error("not supported"), { code: "ENOTSUP" })
		})
		try {
			expect(open().globalState.get<unknown>("modelSettings")).toEqual({ revision: 1 })
			expect(fs.readdirSync(own).filter((name) => name.includes(".adopt."))).toEqual([])
		} finally {
			link.mockRestore()
		}
	})

	it("a copy that fails doesn't stop startup", () => {
		write(path.join(shared, "globalState.json"), { modelSettings: { revision: 1 } })
		const copy = spyOn(fs, "copyFileSync").mockImplementation(() => {
			throw Object.assign(new Error("denied"), { code: "EACCES" })
		})
		try {
			expect(open().globalState.get<unknown>("modelSettings")).toBeUndefined()
		} finally {
			copy.mockRestore()
		}
		expect(open().globalState.get<unknown>("modelSettings")).toEqual({ revision: 1 })
	})

	it("starts empty with nothing to copy, and leaves no stray files", () => {
		const storage = open()
		expect(storage.globalState.get<unknown>("modelSettings")).toBeUndefined()
		expect(fs.readdirSync(own).filter((name) => name.includes(".adopt."))).toEqual([])
	})

	it("windows starting together end up with one copy", () => {
		write(path.join(shared, "globalState.json"), { modelSettings: { revision: 1 } })
		const contexts = [open(), open(), open()]
		expect(contexts.map((storage) => storage.globalState.get<unknown>("modelSettings"))).toEqual(
			Array(3).fill({ revision: 1 }),
		)
		expect(fs.readdirSync(own).filter((name) => name.includes(".adopt."))).toEqual([])
	})

	it("the Marketplace build itself stays on the shared files", () => {
		write(path.join(shared, "globalState.json"), { a: 1 })
		const storage = createStorageContext({ clineDir, stateNamespace: undefined, workspacePath: "/repo" })
		expect(storage.stateDir).toBe(shared)
		expect(fs.existsSync(own)).toBe(false)
	})
})
