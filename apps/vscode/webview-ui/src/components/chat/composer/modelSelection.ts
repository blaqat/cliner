export const formatEffort = (effort: string) =>
	effort === "none" ? "Provider default" : effort === "xhigh" ? "XHigh" : effort.charAt(0).toUpperCase() + effort.slice(1)

/** The effort chip's label: short enough for a narrow sidebar. The menu and tooltip keep {@link formatEffort}. */
export const formatEffortShort = (effort: string) =>
	effort === "none" ? "Default" : effort === "medium" ? "Med" : formatEffort(effort)
