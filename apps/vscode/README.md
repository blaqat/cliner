### Prepare MCP servers with a hook

Create an executable file named `McpServerStart` in any of the extension's hook folders:

- Global: `~/Documents/Cline/Hooks/McpServerStart`
- Workspace: `<workspace>/.clinerules/hooks/McpServerStart`, for each workspace folder
- Runtime override: `<--hooks-dir>/McpServerStart`, when a hooks directory is supplied

On Windows, name the file `McpServerStart.ps1` and use PowerShell. You can also create and toggle this hook in the Hooks tab of the Cline Rules modal. The global Hooks setting controls execution.

All enabled `McpServerStart` hooks run before each server connects. Filter by `serverName` inside the script. This bash example uses `jq` and refreshes a local cache before connecting the `internal` server:

```bash
#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
if [ "$(echo "$INPUT" | jq -r '.mcpServerStart.serverName')" != "internal" ]; then
	echo '{"cancel": false}'
	exit 0
fi
/path/to/refresh-mcp-cache >&2
echo '{"cancel": false}'
```

On macOS or Linux, run `chmod +x` on the hook file. Write diagnostics to stderr and the hook response JSON to stdout.

Stdin contains the common hook metadata: `clineVersion`, `hookName`, `timestamp`, `workspaceRoots`, `userId`, and `model`. There is no chat task ID. The `mcpServerStart` object contains `serverName`, `transportType`, and `reason`, plus `command` and `args` for stdio servers or `url` for HTTP servers. `reason` is `initial`, `restart`, `reconnect`, or `config_changed`. Environment and header values are omitted.

Return `{"cancel": true}` to skip this connection attempt. The server displays "Skipped by McpServerStart hook". Return `{"errorMessage": "Refresh failed"}` to block with that message. Other successful output proceeds. A non-zero exit or the existing 30-second hook timeout blocks the connection and shows the error tail on the server row. Retry Connection runs the hook again. Hooks cannot patch connection credentials through stdout and do not create chat rows. Old per-server `startHook` settings are ignored, with one migration warning per extension process.

Live chats refresh MCP tools between turns. A message already queued when MCP changes may run once with the previous tools; after the refresh, the next turn receives a one-time MCP change notice.
