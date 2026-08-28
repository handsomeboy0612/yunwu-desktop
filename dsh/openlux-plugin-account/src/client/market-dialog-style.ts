/**
 * Width and responsive rules for the WorkBuddy-shaped expert dialogs.
 *
 * The kernel modal primitive intentionally defaults to a 380px confirmation
 * card. Expert details and artifact previews are product surfaces, so their
 * own headless classes supply the larger frame without coupling to the
 * primitive's hashed CSS-module names.
 */

const TAG_ID = 'openlux-plugin-account/market-dialog'

const CSS = `
.openlux-market-expert-detail-dialog {
  width: min(630px, 100%);
  height: auto;
  max-height: min(560px, calc(100vh - 48px));
  min-height: 0;
  padding: 0;
  gap: 0;
  border-radius: 14px;
}
.openlux-market-connector-detail-dialog {
  /* WorkBuddy's connect modal: a narrow centered card (its
     .connector-detail-modal), the asks list scrolling under a fixed head. */
  width: min(520px, 100%);
  height: auto;
  max-height: min(640px, calc(100vh - 48px));
  min-height: 0;
  padding: 0;
  gap: 0;
  border-radius: 16px;
}
.openlux-market-preview-dialog {
  width: min(760px, 100%);
  height: min(620px, calc(100vh - 48px));
  min-height: 480px;
  padding: 0;
  gap: 0;
  border-radius: 18px;
  transition: width 0.16s ease, height 0.16s ease;
}
.openlux-market-preview-dialog.openlux-market-preview-dialog-expanded {
  width: min(1120px, 100%);
  height: calc(100vh - 48px);
}
.openlux-market-custom-dialog {
  /* WorkBuddy's «MCP 服务管理» frame: a wide card whose height holds still,
     so the list ↔ editor swap does not resize the dialog under the pointer. */
  width: min(720px, 100%);
  height: min(600px, calc(100vh - 48px));
  min-height: 420px;
  padding: 0;
  gap: 0;
  border-radius: 14px;
}
.openlux-market-preview-toggle {
  -webkit-app-region: no-drag;
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.openlux-market-preview-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.openlux-market-preview-toggle svg {
  width: 14px;
  height: 14px;
}
.openlux-artifact-stage {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.openlux-artifact-media {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #000;
  object-fit: contain;
}
.openlux-artifact-layers {
  display: flex;
  flex: 0 0 150px;
  min-height: 0;
  flex-direction: column;
  padding: 12px 10px;
  border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-interactive-bg-hover);
}
.openlux-artifact-layers-title {
  flex: 0 0 auto;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.openlux-artifact-layers-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.openlux-artifact-layer {
  position: relative;
  display: block;
  width: 128px;
  height: 74px;
  margin-bottom: 8px;
  padding: 0;
  overflow: hidden;
  border: 2px solid transparent;
  border-radius: 7px;
  background: #111;
  cursor: pointer;
}
.openlux-artifact-layer.is-active {
  border-color: #22c55e;
}
.openlux-artifact-layer iframe {
  position: absolute;
  inset: 0;
  width: 128px;
  height: 74px;
  border: 0;
  pointer-events: none;
}
.openlux-artifact-layer-number {
  position: absolute;
  top: 3px;
  left: 3px;
  z-index: 2;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.58);
  color: #fff;
  font-size: 10px;
}
.openlux-artifact-desk {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--dsw-alias-interactive-bg-hover);
}
.openlux-artifact-desk.has-canvas {
  background: #fff;
}
.openlux-artifact-frame {
  position: absolute;
  z-index: 1;
  border: 0;
  background: #fff;
}
.openlux-artifact-desk.has-canvas .openlux-artifact-frame {
  box-shadow: 0 2px 18px rgba(0, 0, 0, 0.14);
}
.openlux-artifact-grab {
  position: absolute;
  inset: 0;
  z-index: 3;
  cursor: grab;
  touch-action: none;
}
.openlux-artifact-grab:active {
  cursor: grabbing;
}
.openlux-artifact-measure {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
}
.openlux-artifact-measure-box {
  position: absolute;
  box-sizing: border-box;
  border: 1.5px solid #22c55e;
}
.openlux-artifact-measure-tag {
  position: absolute;
  padding: 1px 5px;
  border-radius: 3px;
  transform: translateX(-50%);
  background: #22c55e;
  color: #fff;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.openlux-artifact-modes {
  position: absolute;
  top: 14px;
  left: 50%;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  transform: translateX(-50%);
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
}
.openlux-artifact-mode {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #3f3f46;
  cursor: pointer;
}
.openlux-artifact-mode:hover:not(.is-active) {
  background: rgba(0, 0, 0, 0.06);
}
.openlux-artifact-mode.is-active {
  background: #22c55e;
  color: #fff;
}
.openlux-artifact-zoom {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  outline: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(56, 56, 56, 0.82);
  backdrop-filter: blur(6px);
}
.openlux-artifact-zoom-button {
  display: inline-flex;
  min-width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #fff;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.openlux-artifact-zoom-button:hover:not(:disabled),
.openlux-artifact-zoom-button.is-active {
  background: rgba(255, 255, 255, 0.18);
}
.openlux-artifact-zoom-button:disabled {
  cursor: default;
  opacity: 0.35;
}
.openlux-artifact-zoom-value {
  min-width: 50px;
  gap: 2px;
  font-size: 12px;
}
.openlux-artifact-zoom-scrim {
  position: fixed;
  inset: 0;
  z-index: 5;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: default;
}
.openlux-artifact-zoom-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 6;
  display: flex;
  min-width: 176px;
  flex-direction: column;
  padding: 6px;
  border-radius: 10px;
  outline: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(38, 38, 38, 0.96);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(8px);
}
.openlux-artifact-zoom-input {
  height: 28px;
  margin-bottom: 4px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  outline: 1px solid rgba(74, 222, 128, 0.6);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.openlux-artifact-zoom-item {
  display: flex;
  height: 30px;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.92);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.openlux-artifact-zoom-item:hover {
  background: rgba(255, 255, 255, 0.14);
}
.openlux-artifact-zoom-key {
  color: rgba(255, 255, 255, 0.45);
  font-size: 11px;
}
@media (max-width: 640px) {
  .openlux-market-expert-detail-dialog,
  .openlux-market-connector-detail-dialog,
  .openlux-market-preview-dialog,
  .openlux-market-custom-dialog {
    height: calc(100vh - 32px);
    min-height: 0;
    border-radius: 16px;
  }
  [data-testid="openlux-market-related-cases"] > div {
    grid-template-columns: 1fr !important;
  }
  .openlux-artifact-layers {
    display: none;
  }
}
`

/** Mount this plugin's dialog frame rules once. */
export function installMarketDialogStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', TAG_ID)
  tag.textContent = CSS
  document.head.append(tag)
  return () => { tag.remove() }
}
