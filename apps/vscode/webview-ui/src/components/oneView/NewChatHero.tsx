import { HomeLogo } from "@/components/welcome/HomeHeader"
import { useOneView } from "./OneViewContext"

/**
 * One view's new-chat screen: the logo (the classic home header's size, now that the threads live in
 * the list) and the prompt above the centered composer.
 */
export const NewChatHero = () => (
	<div className="flex flex-col items-center px-4 pb-4" data-testid="one-view-new-chat-hero">
		<HomeLogo className="mb-3 size-16" />
		<h1 className="m-0 text-center text-[19px] leading-tight font-semibold text-foreground">What should Cline do?</h1>
	</div>
)

/** The side list's hide/show toggle, top-left of the new-chat screen (which has no header). */
export const NewChatListToggle = () => {
	const { listToggle } = useOneView()
	if (!listToggle) return null
	return <div className="absolute top-2 left-3 z-10">{listToggle}</div>
}
