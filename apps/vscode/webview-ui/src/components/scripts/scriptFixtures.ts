import type { ScriptEntry } from "@/hooks/useScripts"

export const TEST_MODULE: ScriptEntry = {
	name: "test-module",
	description: "Run one module's tests",
	path: "/repo/.clinerules/scripts/test-module.md",
	scope: "workspace",
	enabled: true,
	approval: "ask_in_ask_mode",
	errors: [],
	options: [
		{ name: "module", kind: "choice", required: true, description: "Module to test", choices: ["api", "web", "shared"] },
		{ name: "filter", kind: "text", required: false, description: "Test name pattern" },
		{ name: "watch", kind: "flag", required: false, description: "Re-run on change" },
	],
}
