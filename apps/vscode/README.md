
### MCP server startup hooks

The extension runs a server's optional `startHook` before each connection, including restarts and reconnects. Add it to that server in `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "internal": {
      "type": "streamableHttp",
      "url": "https://mcp.example.com/mcp",
      "startHook": {
        "command": "node",
        "args": ["/path/to/refresh-mcp-token.js"],
        "cwd": "/path/to/project",
        "env": { "ACCOUNT": "${env:MCP_ACCOUNT}" },
        "timeout": 60
      }
    }
  }
}
```

The hook receives JSON on stdin with `serverName`, `transportType`, and the server's `command` and `args` or `url`. Environment variables and HTTP headers are omitted. Avoid putting credentials in commands, arguments, or URLs.

The last non-empty stdout line may contain `{"env":{"TOKEN":"value"},"headers":{"Authorization":"Bearer value"}}`. The extension merges `env` into stdio connections and `headers` into HTTP connections for that attempt only. It never saves these patches or changes the extension's environment. Other stdout is logged. A nonzero exit or timeout blocks the connection and shows the stderr tail in MCP settings. The default timeout is 60 seconds. Retry Connection runs the hook again. `${env:VAR}` expansion works in hook settings just as it does in server settings. The CLI accepts this field but does not execute extension startup hooks.

Live chats refresh MCP tools between turns. Queued prompts wait for the refresh, and the next turn receives a one-time MCP change notice.
