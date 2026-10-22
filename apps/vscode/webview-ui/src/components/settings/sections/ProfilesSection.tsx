import ProfilesPanel from "../profiles/ProfilesPanel"
import Section from "../Section"

interface ProfilesSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
}

const ProfilesSection = ({ renderSectionHeader }: ProfilesSectionProps) => (
	<div>
		{renderSectionHeader?.("profiles")}
		<Section>
			<ProfilesPanel />
		</Section>
	</div>
)

export default ProfilesSection
