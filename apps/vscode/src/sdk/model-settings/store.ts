import { createDefaultModelSettings, type ModelSettings, ModelSettingsSchema } from "@shared/model-settings"
import type { StateManager } from "@/core/storage/StateManager"

/** Opt-in host store. Reading an absent store never persists defaults. */
export class ModelSettingsStore {
	constructor(private readonly state: Pick<StateManager, "getGlobalStateKey" | "setGlobalState">) {}
	get(): ModelSettings {
		const saved = this.state.getGlobalStateKey("modelSettings")
		return saved === undefined ? createDefaultModelSettings() : ModelSettingsSchema.parse(saved)
	}
	set(value: ModelSettings): void {
		this.state.setGlobalState("modelSettings", ModelSettingsSchema.parse(value))
	}
}
