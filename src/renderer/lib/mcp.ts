/** The ready-to-copy connection lines for the MCP server. `url` is where it listens now, or where it would listen. */
export function mcpSnippets(url: string, tokenSet: boolean): { http: string; stdio: string; headless: string } {
  return {
    http: `claude mcp add --transport http cartoon-studio ${url}${tokenSet ? ' --header "Authorization: Bearer <token>"' : ''}`,
    stdio: 'claude mcp add cartoon-studio -- yarn --cwd <repo> engine -- mcp',
    headless: 'yarn mcp   (no window: node out/engine/index.js --mcp-only [--port N])'
  }
}
