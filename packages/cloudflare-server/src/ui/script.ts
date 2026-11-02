export const SCRIPT = `
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-opens]');
  if (opener) document.getElementById(opener.dataset.opens).showModal();
  const closer = e.target.closest('[data-closes]');
  if (closer) closer.closest('dialog').close();
  const back = e.target.closest('[data-back]');
  if (back) window.opener ? window.close() : history.back();
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(document.getElementById(copy.dataset.copy).value)
      .then(() => { copy.querySelector('span').textContent = 'Copied'; });
  }
});
document.addEventListener('change', (e) => {
  const form = e.target.closest('form[data-autosubmit]');
  if (form) form.requestSubmit();
});
document.addEventListener('submit', (e) => {
  const button = e.target.querySelector('button[type=submit]');
  if (button) button.classList.add('pending');
});
for (const dialog of document.querySelectorAll('dialog[data-autoopen]')) dialog.showModal();
`;
