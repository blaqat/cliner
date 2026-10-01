import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

const PERMISSIONS = [
	["subagentsAllowWrite", "Allow write subagents"],
	["subagentsAllowCommands", "Allow shell commands"],
	["subagentsAllowMcp", "Allow MCP tools"],
	["subagentsAllowWeb", "Allow web access"],
] as const

export default function SubagentsSettingsSection({
	renderSectionHeader,
}: {
	renderSectionHeader: (id: string) => JSX.Element | null
}) {
	const state = useExtensionState()
	const enabled = state.subagentsEnabled ?? true
	const [limit, setLimit] = useState<string | undefined>()
	const storedLimit = state.subagentsMaxConcurrent ? String(state.subagentsMaxConcurrent) : ""
	return (
		<div>
			{renderSectionHeader("subagents")}
			<Section>
				<div className="flex items-center gap-2 mb-3">
					<Switch
						checked={enabled}
						id="subagents-enabled"
						onCheckedChange={(value) => updateSetting("subagentsEnabled", value)}
					/>
					<label htmlFor="subagents-enabled">Enable subagents</label>
				</div>
				<p className="text-sm text-description mb-4">
					Delegate tasks to agents that inherit your model and configuration. Ask mode gives subagents investigation
					tools. Act mode can also allow editing.
				</p>
				<label className="block mb-2" htmlFor="subagents-limit">
					Maximum concurrent subagents
				</label>
				<Input
					disabled={!enabled}
					id="subagents-limit"
					min={1}
					onBlur={() => {
						const value = limit ?? storedLimit
						const number = value.trim() === "" ? 0 : Number(value)
						if (Number.isInteger(number) && number >= 0) updateSetting("subagentsMaxConcurrent", number)
						setLimit(undefined)
					}}
					onChange={(event) => setLimit(event.target.value)}
					placeholder="Unlimited"
					step={1}
					type="number"
					value={limit ?? storedLimit}
				/>
				<p className="text-xs text-description mt-2 mb-4">Leave blank for unlimited. Includes nested subagents.</p>
				<div className="flex flex-col gap-3">
					{PERMISSIONS.map(([key, label]) => (
						<div className="flex items-center gap-2" key={key}>
							<Switch
								checked={state[key] ?? true}
								disabled={!enabled}
								id={key}
								onCheckedChange={(value) => updateSetting(key, value)}
							/>
							<label htmlFor={key}>{label}</label>
						</div>
					))}
				</div>
				<p className="text-sm text-description mt-4">
					Subagents stay within the parent's permissions and approval settings. Changes apply at the next idle session
					boundary.
				</p>
			</Section>
		</div>
	)
}
