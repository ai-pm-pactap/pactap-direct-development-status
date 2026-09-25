import { setPassphrase, loadReport } from './report-source.mjs';
const $ = id => document.getElementById(id);
let generation = 0, request = null, busy = false, dashboard = null;

function reset() {
  generation++;
  request?.abort(); request = null;
  setPassphrase('');
  $('passphrase').value = '';
  $('passphrase').disabled = false;
  $('unlock-submit').disabled = false;
  $('cancel-unlock').hidden = true;
  $('unlock-status').textContent = '';
  busy = false;
}
function lock() {
  reset();
  dashboard?.disposeDashboard();
  $('protected-content').hidden = true;
  $('protected-content').replaceChildren();
  $('unlock-screen').hidden = false;
}
$('cancel-unlock').addEventListener('click', () => { reset(); $('passphrase').focus(); });
$('lock-dashboard').addEventListener('click', () => { lock(); location.reload(); });
$('unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || window.top !== window.self || !globalThis.crypto?.subtle) return;
  busy = true;
  const attempt = ++generation;
  const controller = new AbortController(); request = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  $('unlock-error').textContent = '';
  $('unlock-submit').disabled = true;
  $('cancel-unlock').hidden = false;
  $('unlock-status').textContent = 'Opening the encrypted status report…';
  try {
    setPassphrase($('passphrase').value);
    $('passphrase').value = '';
    $('passphrase').disabled = true;
    const report = await loadReport(controller.signal);
    if (attempt !== generation) return;
    dashboard = await import('./app.mjs');
    controller.signal.throwIfAborted();
    if (attempt !== generation) return;
    dashboard.startDashboard(report);
    $('protected-content').hidden = false;
    $('unlock-screen').hidden = true;
    $('main').setAttribute('tabindex', '-1');
    $('main').focus();
  } catch {
    if (attempt === generation) {
      setPassphrase('');
      dashboard?.disposeDashboard();
      $('protected-content').hidden = true;
      $('unlock-error').textContent = 'Unable to unlock. Check the passphrase and try again. If it still fails, refresh or ask the maintainer for the current passphrase.';
      $('passphrase').disabled = false;
      $('passphrase').focus();
    }
  } finally {
    clearTimeout(timeout);
    if (attempt === generation) { $('passphrase').value = ''; busy = false; request = null; $('passphrase').disabled = false; $('unlock-submit').disabled = false; $('cancel-unlock').hidden = true; $('unlock-status').textContent = ''; }
  }
});
window.addEventListener('pagehide', lock);
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); else $('passphrase').value = ''; });
if (window.top !== window.self || !globalThis.crypto?.subtle) {
  $('unlock-submit').disabled = true;
  $('passphrase').disabled = true;
  $('unlock-error').textContent = 'Open this page directly over HTTPS in a current browser to unlock the report.';
}
