// Public Claude provider-list contract consumed by the shell MCP adapter.
// Keeping this narrow avoids initializing every provider service when the
// shell only needs the host-owned Claude MCP reader.
export { ClaudeMcpProvider } from './claude-mcp.provider.js';
