// Build-time text imports (`with { type: 'text' }`, Bun loader): markdown
// files bundled into the plugin as raw strings.
declare module '*.md' {
  const text: string;
  export default text;
}
