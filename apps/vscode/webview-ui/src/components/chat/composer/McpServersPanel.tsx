import { EmptyRequest } from "@shared/proto/cline/common"
import type { McpServers } from "@shared/proto/cline/mcp"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { useEffect } from "react"
import ServersToggleList from "@/components/mcp/configuration/tabs/installed/ServersToggleList"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { McpServiceClient } from "@/services/grpc-client"

/**
 * MCP server toggles, shown inline in the composer's ＋ menu. Fetches the latest servers when it
 * mounts, so render it only while that panel is open.
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
			<div className="flex-1 overflow-y-auto px-3 pb-3 pt-1" style={{ minHeight: 0 }}>
				<ServersToggleList hasTrashIcon={false} isExpandable={false} listGap="small" servers={mcpServers} />
			</div>
			<button
				className="mx-1 mb-1 flex h-6 cursor-pointer items-center gap-1.5 rounded-xs border-0 bg-transparent px-2 text-left text-xs text-link hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline-none"
				onClick={() => {
					onOpenSettings()
					navigateToMcp("configure")
				}}
				type="button">
				<span aria-hidden className="codicon codicon-gear text-[12px]!" />
				MCP server settings…
			</button>
		</div>
	)
}

export default McpServersPanel
