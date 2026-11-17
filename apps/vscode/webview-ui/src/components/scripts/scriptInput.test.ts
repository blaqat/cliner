import { describe, expect, it } from "vitest"
import { TEST_MODULE } from "./scriptFixtures"
import { completeScriptInput, isScriptInputSendable, matchScriptInput } from "./scriptInput"

describe("matchScriptInput", () => {
	it("needs the script name at the start followed by a space", () => {
		expect(matchScriptInput("/test-module module:api", [TEST_MODULE])).toMatchObject({
			prefix: "/test-module ",
			optionsText: "module:api",
			suffix: "",
		})
		expect(matchScriptInput("/test-module", [TEST_MODULE])).toBeNull()
		expect(matchScriptInput("/test-mod ", [TEST_MODULE])).toBeNull()
		expect(matchScriptInput("run /test-module ", [TEST_MODULE])).toBeNull()
		expect(matchScriptInput("/other ", [TEST_MODULE])).toBeNull()
	})

	it("keeps the first line as options and later lines as a note", () => {
		expect(matchScriptInput("/test-module module:api \nthen fix", [TEST_MODULE])).toMatchObject({
			optionsText: "module:api ",
			suffix: "\nthen fix",
		})
	})
})

describe("isScriptInputSendable", () => {
	it("blocks until required options are set and valid", () => {
		const draft = (text: string) => matchScriptInput(text, [TEST_MODULE])
		expect(isScriptInputSendable(null)).toBe(true)
		expect(isScriptInputSendable(draft("/test-module "))).toBe(false)
		expect(isScriptInputSendable(draft("/test-module module:api"))).toBe(true)
		expect(isScriptInputSendable(draft("/test-module module:api bogus"))).toBe(false)
	})
})

describe("completeScriptInput", () => {
	it("jumps to the first missing required option, then completes the choice and places the cursor", () => {
		const first = completeScriptInput(matchScriptInput("/test-module ", [TEST_MODULE])!)
		expect(first).toEqual({ text: "/test-module module:", cursor: "/test-module module:".length })
		const second = completeScriptInput(matchScriptInput(first!.text, [TEST_MODULE])!)
		expect(second?.text).toBe("/test-module module:api ")
	})

	it("keeps the note below the options line", () => {
		const done = completeScriptInput(matchScriptInput("/test-module module:sh\nnote", [TEST_MODULE])!)
		expect(done).toEqual({ text: "/test-module module:shared \nnote", cursor: "/test-module module:shared ".length })
	})

	it("returns null when nothing changes", () => {
		expect(completeScriptInput(matchScriptInput("/test-module module:api ", [TEST_MODULE])!)).toBeNull()
	})
})
