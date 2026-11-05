import { state } from "../shell/rowFactories"
import { isAdminOrOwner } from "@/components/account/helpers"
export const ABOUT_ROWS = [
	state({
		id: "about.info",
		label: "Cline",
		description: "Version, what's new, shortcuts and links.",
		aliases: ["version", "release notes", "shortcuts", "help"],
	}),
	state({
		id: "about.remote-config",
		parent: "about.info",
		label: "Remote Config",
		description: "What your organization manages, and opting out.",
		aliases: ["organization", "admin", "opentelemetry", "prompt uploading"],
		visible: (ctx) => !!ctx.activeOrganization && isAdminOrOwner(ctx.activeOrganization),
	}),
]
