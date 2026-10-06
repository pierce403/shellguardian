const copy = document.querySelector('#copy-install');
const command = document.querySelector('#install-command');
const status = document.querySelector('#copy-status');
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    status.textContent = 'Command copied. Paste it into your terminal when ready.';
    copy.textContent = 'Copied';
    window.setTimeout(() => {
      copy.textContent = 'Copy command';
    }, 2500);
  } catch {
    status.textContent = 'Select the command above to copy it manually.';
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
  }
});
