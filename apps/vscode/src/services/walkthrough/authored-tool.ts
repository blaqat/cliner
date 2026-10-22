import { createTool } from "@cline/shared"
import type { AuthoredWalkthroughInput } from "@shared/Walkthrough"
import { saveAuthoredWalkthrough, walkthroughReady } from "./authored"

export function createPresentWalkthroughTool() {
	return createTool<AuthoredWalkthroughInput, string>({
		name: "present_walkthrough",
		description:
			"Present a change set the user should review, such as a merge request fetched through MCP. Copy unified diff hunks verbatim from the source. Group stops into conceptual chapters. Use 2–6 word stop titles and short prose with inline code only. Narrative stops may have no hunks. Limits: 8 chapters, 60 stops, 400 hunks, 300000 total patch characters. This displays a review page and does not change local files. After success, do not repeat its content.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				focus: { type: "string" },
				origin: {
					type: "object",
					properties: { label: { type: "string" }, url: { type: "string" } },
					required: ["label"],
				},
				chapters: {
					type: "array",
					maxItems: 8,
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							stops: {
								type: "array",
								items: {
									type: "object",
									properties: {
										title: { type: "string" },
										prose: { type: "string" },
										hunks: {
											type: "array",
											items: {
												type: "object",
												properties: { path: { type: "string" }, patch: { type: "string" } },
												required: ["path", "patch"],
											},
										},
									},
									required: ["title", "prose", "hunks"],
								},
							},
						},
						required: ["title", "stops"],
					},
				},
			},
			required: ["title", "chapters"],
		},
		// A closing sentence is optional: the page itself is the answer, so an empty reply ends the turn.
		lifecycle: { emptyResponseCompletes: true },
		retryable: false,
		execute: async (input, context) => {
			if (!context.sessionId || !/^[a-zA-Z0-9_-]+$/.test(context.sessionId)) throw new Error("A thread session is required")
			const walk = await saveAuthoredWalkthrough(context.sessionId, input)
			return JSON.stringify({
				walkthroughReady: walkthroughReady(walk),
				message:
					"The walkthrough is now shown to the user as a card they can open. Finish the turn with one short sentence and do not repeat or summarize its content.",
			})
		},
	})
}
