// Native Web Component: a live-ticking deadline badge. No framework, no
// dependency — just customElements.define. Re-renders its own text content
// every 60s based on the datetime attribute already rendered server-side.
class DeadlineCountdown extends HTMLElement {
  connectedCallback() {
    this._tick();
    this._interval = setInterval(() => this._tick(), 60000);
  }
  disconnectedCallback() {
    clearInterval(this._interval);
  }
  _tick() {
    const dt = this.getAttribute('datetime');
    if (!dt) return;
    const target = new Date(dt);
    if (isNaN(target.getTime())) return;
    const diffMs = target.getTime() - Date.now();
    const overdue = diffMs < 0;
    const abs = Math.abs(diffMs);
    const totalHrs = Math.floor(abs / 3600000);
    const days = Math.floor(totalHrs / 24);
    const hrs = totalHrs % 24;
    const parts = days > 0 ? `${days}d ${hrs}h` : `${hrs}h`;
    this.textContent = overdue ? `Overdue by ${parts}` : `${parts} left`;
  }
}
customElements.define('deadline-countdown', DeadlineCountdown);

// Instant avatar preview: show the picked photo immediately, before the
// form is saved. Delegated on document so it works with no re-binding
// needed, regardless of HTMX swaps.
document.addEventListener('change', (e) => {
  if (!e.target.matches('#avatarInput')) return;
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const preview = document.getElementById('avatarPreview');
    if (preview) preview.innerHTML = `<img src="${ev.target.result}" alt="">`;
  };
  reader.readAsDataURL(file);
});

// Pointer-reactive background orbs on auth pages — harmless no-op elsewhere
// since it just checks for the element and exits if not present.
(function () {
  const field = document.getElementById('orbField');
  if (!field) return;
  document.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth - 0.5) * 60;
    const y = (e.clientY / window.innerHeight - 0.5) * 60;
    field.style.transform = `translate(${x}px, ${y}px)`;
  });
})();
