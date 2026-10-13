import { describe, expect, it } from "bun:test"
import type { TaskTag } from "./task-groups"
import { extractTicketTags, mergeAutoTicketTags } from "./ticket-tags"

describe("extractTicketTags", () => {
	it("finds Jira/Linear style keys", () => {
		expect(extractTicketTags("Look into PROJ-491: export times out, see also AB2-7")).toEqual(["PROJ-491", "AB2-7"])
	})

	it("ignores lowercase, single-letter and non-ticket prefixes", () => {
		expect(extractTicketTags("proj-1 X-1 UTF-8 SHA-256 ISO-8601 GPT-5 xPROJ-2")).toEqual([])
	})

	it("returns nothing for empty input", () => {
		expect(extractTicketTags(undefined)).toEqual([])
		expect(extractTicketTags("")).toEqual([])
	})

	it("dedupes, keeping first-appearance order", () => {
		expect(extractTicketTags("PROJ-2 then PROJ-1 then PROJ-2 again")).toEqual(["PROJ-2", "PROJ-1"])
	})

	it("reads keys from Jira URLs", () => {
		expect(extractTicketTags("https://acme.atlassian.net/browse/PROJ-482")).toEqual(["PROJ-482"])
		expect(extractTicketTags("https://acme.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-9")).toEqual(
			["PROJ-9"],
		)
	})

	it("reads keys from Linear URLs, including lowercased ones", () => {
		expect(extractTicketTags("https://linear.app/acme/issue/ENG-12/fix-the-thing")).toEqual(["ENG-12"])
		expect(extractTicketTags("https://linear.app/acme/issue/eng-13/fix")).toEqual(["ENG-13"])
	})

	it("turns GitHub issue URLs into owner/repo#N", () => {
		expect(extractTicketTags("see https://github.com/cline/cline/issues/1234 and PROJ-1")).toEqual([
			"cline/cline#1234",
			"PROJ-1",
		])
	})
})

describe("mergeAutoTicketTags", () => {
	const user: TaskTag = { kind: "ticket", value: "PROJ-1", source: "user" }

	it("appends new detections as auto ticket tags", () => {
		expect(mergeAutoTicketTags([user], ["PROJ-2"], [])).toEqual([user, { kind: "ticket", value: "PROJ-2", source: "auto" }])
	})

	it("skips values already tagged (case-insensitively) or dismissed", () => {
		expect(mergeAutoTicketTags([user], ["proj-1", "PROJ-3"], ["PROJ-3"])).toBeUndefined()
	})

	it("returns undefined when nothing was detected", () => {
		expect(mergeAutoTicketTags(undefined, [], undefined)).toBeUndefined()
	})

	it("dedupes within the detected list", () => {
		expect(mergeAutoTicketTags(undefined, ["A1-1", "a1-1"], undefined)).toEqual([
			{ kind: "ticket", value: "A1-1", source: "auto" },
		])
	})
})
