// Vite's `?raw` import: the file's text (the engine build and the tests inline docs/mcp-guide.md this way).
declare module '*.md?raw' {
  const text: string
  export default text
}
