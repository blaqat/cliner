import ApiProfilesPanel from "../apiProfiles/ApiProfilesPanel"
import Section from "../Section"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
	initialModelTab?: "recommended" | "free"
}

const ApiConfigurationSection = ({ renderSectionHeader }: ApiConfigurationSectionProps) => {
	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				<ApiProfilesPanel />
			</Section>
		</div>
	)
}

export default ApiConfigurationSection
