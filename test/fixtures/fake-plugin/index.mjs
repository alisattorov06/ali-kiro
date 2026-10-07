// Minimal safe plugin used by ali-kiro hermetic tests (id: x).
// pluginImportSmoke imports this entry in a child node process and expects
// stdout "<id> function" (m.default.id + typeof m.default.setup).
export default {
  id: 'x',
  setup() {
    return true;
  },
};