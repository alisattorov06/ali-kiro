// Asset-tree plugin for opencode-provider hermetic tests (id: fake).
// pluginImportSmoke imports this entry in a child node process and expects
// stdout "<id> function" (m.default.id + typeof m.default.setup).
export default {
  id: 'fake',
  setup() {
    return true;
  },
};