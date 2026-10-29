import { EmptyRequest } from "@shared/proto/cline/common"
import type { McpServers } from "@shared/proto/cline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { useEffect } from "react"
import { MENU_ICON_CLASS, MENU_ITEM_CLASS } from "@/components/common/menuStyles"
import ServersToggleList from "@/components/mcp/configuration/tabs/installed/ServersToggleList"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { McpServiceClient } from "@/services/grpc-client"

/**
 * MCP server toggles, shown in the overlay the view title bar's MCP servers button opens. Its
 * "MCP server settings…" link reaches the full MCP page. Fetches the latest servers when it mounts,
 * so render it only while the overlay is open.
 */
const McpServersPanel = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
	const { mcpServers, navigateToMcp, setMcpServers } = useExtensionState()

	useEffect(() => {
		McpServiceClient.getLatestMcpServers(EmptyRequest.create({}))
			.then((response: McpServers) => {
				if (response.mcpServers) {
					setMcpServers(convertProtoMcpServersToMcpServers(response.mcpServers))
				}
			})
			.catch((error) => console.error("Failed to fetch MCP servers:", error))
	}, [setMcpServers])

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="mcp-servers-panel">
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
				<ServersToggleList hasTrashIcon={false} isExpandable={false} listGap="small" servers={mcpServers} />
			</div>
			<button
				className={cn(MENU_ITEM_CLASS, "mx-1 mb-1 w-auto text-link")}
				onClick={() => {
					onOpenSettings()
					navigateToMcp("configure")
				}}
				type="button">
				<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-gear")} />
				MCP server settings…
			</button>
		</div>
	)
}

export default McpServersPanel
