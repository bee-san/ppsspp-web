/**
 * Open the side panel on a given tab. The tabs themselves belong to the classic runtime
 * (`activatePanelTab` in ppsspp-runtime.js, driven by the `#panelTabSelect` change event);
 * this helper only pokes those controls, with a DOM fallback for before the runtime boots.
 */
export function openPanelTab(name: string): void {
  const doc = document;
  if (!doc.body.classList.contains('panel-open')) {
    const toggle = doc.getElementById('panelToggleBtn') as HTMLButtonElement | null;
    if (toggle) toggle.click();
    else {
      doc.body.classList.add('panel-open');
      try {
        localStorage.setItem('ppsspp_panel_open', '1');
      } catch {
        /* storage unavailable */
      }
    }
  }
  const sel = doc.getElementById('panelTabSelect') as HTMLSelectElement | null;
  if (sel && [...sel.options].some((o) => o.value === name)) {
    sel.value = name;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    doc.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset['tab'] === name));
    const id = 'tab' + name.charAt(0).toUpperCase() + name.slice(1);
    doc.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === id));
  }
}
