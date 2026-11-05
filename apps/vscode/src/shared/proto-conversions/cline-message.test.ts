import { describe, expect, it } from "vitest"
import type { ClineMessage } from "../ExtensionMessage"
import { convertClineMessageToProto, convertProtoToClineMessage } from "./cline-message"

describe("cline-message proto conversion", () => {
	it("keeps a sent message's linked messages, so the bubble can show them as chips", () => {
		const message: ClineMessage = {
			ts: 1,
			type: "say",
			say: "user_feedback",
			text: "use this",
			messageReferences: [
				{ threadId: "7_src", threadTitle: "Dev plan", author: "user", text: "Cap exports", messageIndex: 0, block: 1 },
				{ threadId: "8_src", threadTitle: "Infra", author: "assistant", text: "Use the queue.", toolCallId: "call_1" },
			],
		}
		const back = convertProtoToClineMessage(convertClineMessageToProto(message))
		expect(back.messageReferences).toEqual(message.messageReferences)
	})

	it("adds no references to a message without any", () => {
		const back = convertProtoToClineMessage(convertClineMessageToProto({ ts: 2, type: "say", say: "text", text: "hi" }))
		expect(back.messageReferences).toBeUndefined()
	})
})
