import type { AutomationDefinition } from "@shared/automations"
import { describe, expect, it } from "vitest"
import { automationDraftValues, parseAutomationDraft, type RunnableAutomation, serializeAutomationDraft } from "./automationInput"

const definition: AutomationDefinition = {
	name: "fix",
	title: "",
	description: "Fix it",
	arguments: [
		{ name: "ticket", kind: "ticket", required: true, description: "" },
		{ name: "depth", kind: "choice", required: false, description: "", choices: ["quick", "deep"], default: "quick" },
		{ name: "note", kind: "text", required: false, description: "" },
	],
	steps: [],
}
const automations = [
	{ name: "fix", definition, trusted: true, fingerprint: "fp", path: "/x", scope: "workspace", errors: [] },
] as unknown as RunnableAutomation[]

describe("automation drafts", () => {
	it("needs a space after a known name", () => {
		expect(parseAutomationDraft("/fix", automations)).toBeNull()
		expect(parseAutomationDraft("/other x", automations)).toBeNull()
		expect(parseAutomationDraft("/fix ", automations)).toMatchObject({ values: {}, context: "" })
	})

	it("fills arguments in order from bare words and quoted phrases; the rest is context", () => {
		expect(parseAutomationDraft('/fix P-1 deep "two words" and more\nline two', automations)).toMatchObject({
			values: { ticket: "P-1", depth: "deep", note: "two words" },
			context: "and more\nline two",
		})
	})

	it("reads name:value in any order, then fills the rest in order", () => {
		expect(parseAutomationDraft("/fix depth:deep P-2 https://x.io/a?b=c", automations)).toMatchObject({
			values: { depth: "deep", ticket: "P-2", note: "https://x.io/a?b=c" },
			context: "",
		})
	})

	it("round-trips through the draft text", () => {
		const values = { ticket: "P-3", note: 'says "hi" \\ there' }
		const text = serializeAutomationDraft("fix", definition.arguments, values, "\nfirst\n  second")
		expect(text).toBe('/fix ticket:P-3 note:"says \\"hi\\" \\\\ there"\n\nfirst\n  second')
		expect(parseAutomationDraft(text, automations)).toMatchObject({ values, context: "\nfirst\n  second" })
		expect(serializeAutomationDraft("fix", definition.arguments, {}, "")).toBe("/fix ")
	})

	it("says why it can't run: a missing required argument or a choice that isn't one", () => {
		const draft = (text: string) => parseAutomationDraft(text, automations)!
		expect(automationDraftValues(draft("/fix "))).toEqual({ reason: "Needs ticket" })
		expect(automationDraftValues(draft("/fix P-1 medium"))).toEqual({ reason: "depth must be one of quick, deep" })
		expect(automationDraftValues(draft("/fix P-1"))).toEqual({ values: { ticket: "P-1" } })
	})
})
