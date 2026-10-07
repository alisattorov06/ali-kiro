// v2 server entry forwarder for directory-form plugin loading, e.g.
//   "plugin": ["/absolute/path/to/this/checkout"]
// Package-name installs resolve `exports["./server"]` instead and never load
// this file. Keep the target in sync with the build output.
export { default } from "./dist/index.js";