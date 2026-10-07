// v2 TUI entry forwarder for directory-form plugin loading, e.g.
//   "plugin": ["file:///absolute/path/to/this/checkout"]
// Package-name installs resolve `exports["./tui"]` instead and never load
// this file. Keep the target in sync with the build output.
export { default } from './dist/tui2.js';
