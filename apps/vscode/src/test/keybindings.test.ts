import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

interface Keybinding {
	command: string
	key?: string
	mac?: string
	win?: string
	linux?: string
	when?: string
}

const packagePath = path.join(import.meta.dir, "..", "..", "package.json")

async function loadKeybindings(): Promise<Keybinding[]> {
	const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { contributes: { keybindings: Keybinding[] } }
	return manifest.contributes.keybindings
}

/**
 * VS Code forwards webview keydowns to the workbench, so any webview shortcut
 * that also has a global workbench binding needs a keybinding scoped to
 * `focusedView == <sidebar view>` that claims the key before the default
 * (save, chords, …) can fire. These checks keep the manifest honest — command
 * ids mirror the `cline.*` names in src/registry.ts.
 */
describe("package.json keybindings", () => {
	it("scopes every focusedView binding to the Cline sidebar view", async () => {
		const keybindings = await loadKeybindings()
		const focused = keybindings.filter((k) => k.when?.includes("focusedView"))
		expect(focused.length).toBeGreaterThan(0)
		for (const binding of focused) {
			expect(binding.when).toBe("focusedView == claude-dev.SidebarProvider")
		}
	})

	it("claims ⌘K / Ctrl+K while Cline is focused so the chord prefix can't eat the next key", async () => {
		const keybindings = await loadKeybindings()
		const binding = keybindings.find((k) => k.command === "cline.searchShortcut")
		expect(binding).toBeDefined()
		expect(binding?.key).toBe("ctrl+k")
		expect(binding?.mac).toBe("cmd+k")
	})

	it("claims ⌘S / Ctrl+S while Cline is focused so it stashes instead of saving a file", async () => {
		const keybindings = await loadKeybindings()
		const binding = keybindings.find((k) => k.command === "cline.stashShortcut")
		expect(binding).toBeDefined()
		expect(binding?.key).toBe("ctrl+s")
		expect(binding?.mac).toBe("cmd+s")
	})
})
