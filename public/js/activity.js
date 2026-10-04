// Records "time worked": while the employee is really using the portal (tab visible and some
// mouse / keyboard / touch in the last 2 minutes) a heartbeat is sent every 30 s. The server
// credits the elapsed time to today, which feeds the Progress chart.
(function () {
  let lastInput = Date.now();
  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach((ev) => addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true }));

  function beat() {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastInput > 120000) return;
    fetch('/employee/heartbeat', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, keepalive: true }).catch(() => {});
  }
  setInterval(beat, 30000);
  setTimeout(beat, 3000);
})();
