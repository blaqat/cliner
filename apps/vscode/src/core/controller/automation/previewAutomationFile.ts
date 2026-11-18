import { String, StringRequest } from "@shared/proto/cline/common"
import { serializeAutomation } from "@/sdk/automations/automation-file"
import { parseDefinitionJson } from "@/sdk/automations/automation-json"
import { Controller } from ".."

/** The readable file a definition saves as, for the builder's file view. Nothing is written. */
export async function previewAutomationFile(_controller: Controller, request: StringRequest): Promise<String> {
	return String.create({ value: serializeAutomation(parseDefinitionJson(request.value)) })
}
