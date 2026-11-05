import { describe, expect, it } from "bun:test"
import { serviceHandlers, serviceRequestDecoders } from "@generated/hosts/vscode/protobus-services"
import { RelativePathsRequest } from "@shared/proto/cline/file"
import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/cline/state"
import { decodeCoreConnectionRequestMessage } from "../core-connection-dispatcher"

/**
 * The core connection delivers protobus requests as proto3 JSON produced by the
 * webview's ts-proto toJSON encoders. These tests round-trip real toJSON output
 * through the dispatcher's decode step to pin the invariants the handlers rely
 * on: repeated fields are arrays even when the wire omitted them, and enums are
 * numeric even though the wire spells them as names.
 */
describe("core connection request decoding", () => {
	it("restores empty repeated fields that proto3 JSON omits", () => {
		const wireJson = JSON.parse(JSON.stringify(RelativePathsRequest.toJSON(RelativePathsRequest.create({ uris: [] }))))
		// The wire format really does drop the empty array; without that this test would not be exercising anything.
		expect(wireJson.uris).toBeUndefined()

		const decoded = decodeCoreConnectionRequestMessage(
			"cline.FileService",
			"getRelativePaths",
			wireJson,
		) as RelativePathsRequest
		expect(decoded.uris).toEqual([])
	})

	it("converts enum names back to numeric enum values", () => {
		const wireJson = JSON.parse(
			JSON.stringify(TogglePlanActModeRequest.toJSON(TogglePlanActModeRequest.create({ mode: PlanActMode.ACT }))),
		)
		expect(wireJson.mode).toBe("ACT")

		const decoded = decodeCoreConnectionRequestMessage(
			"cline.StateService",
			"togglePlanActModeProto",
			wireJson,
		) as TogglePlanActModeRequest
		expect(decoded.mode).toBe(PlanActMode.ACT)
	})

	it("restores an enum's zero value when proto3 JSON omits the field", () => {
		const wireJson = JSON.parse(
			JSON.stringify(TogglePlanActModeRequest.toJSON(TogglePlanActModeRequest.create({ mode: PlanActMode.PLAN }))),
		)
		expect(wireJson.mode).toBeUndefined()

		const decoded = decodeCoreConnectionRequestMessage(
			"cline.StateService",
			"togglePlanActModeProto",
			wireJson,
		) as TogglePlanActModeRequest
		expect(decoded.mode).toBe(PlanActMode.PLAN)
	})

	it("passes unknown services and methods through untouched", () => {
		const message = { anything: "goes" }
		expect(decodeCoreConnectionRequestMessage("cline.NoSuchService", "noSuchMethod", message)).toBe(message)
		expect(decodeCoreConnectionRequestMessage("cline.ModelsService", "noSuchMethod", message)).toBe(message)
	})

	it("has a decoder for every registered protobus handler", () => {
		for (const [serviceName, handlers] of Object.entries(serviceHandlers)) {
			const decoders = serviceRequestDecoders[serviceName]
			expect(decoders).toBeDefined()
			for (const methodName of Object.keys(handlers)) {
				expect(typeof decoders[methodName]).toBe("function")
			}
		}
	})
})
