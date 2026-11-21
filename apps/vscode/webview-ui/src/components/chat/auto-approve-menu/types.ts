import { AutoApprovalSettings } from "@shared/AutoApprovalSettings"

export interface ActionMetadata {
	id: keyof AutoApprovalSettings["actions"] | "enableNotifications"
	label: string
	shortName: string
	icon: string
	/** A limit the toggle can't lift, shown under it. */
	note?: string
	subAction?: ActionMetadata
	sub?: boolean
	parentActionId?: string
}
