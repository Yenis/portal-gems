const logEl = document.getElementById('log');
const codeEl = document.getElementById('code');

window.portalgems.onLog((line) => {
  logEl.textContent += '\n' + line;
});

document.getElementById('send').addEventListener('click', () => {
  logEl.textContent += '\n--- SEND ---';
  window.portalgems.send();
});

document.getElementById('recv').addEventListener('click', () => {
  const code = codeEl.value.trim();
  if (!code) return;
  logEl.textContent += '\n--- RECV ---';
  window.portalgems.recv(code);
});
