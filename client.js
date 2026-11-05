// The monitor now renders in a separate always-on-top window (widget.ps1),
// started by the Host half. Nothing is drawn inside the Harness page, so the
// conversation stays unobstructed; this module only has to load cleanly.
window.__ModuleLoader__.load({
  id: '@local/codex-relay-monitor',
  factory() {
    return {
      apply() {},
    }
  },
})
