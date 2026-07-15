const form = document.querySelector('#sandboxForm');
const result = document.querySelector('#result');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = form.querySelector('[data-testid="name"]').value;
  const priority = form.querySelector('[data-testid="priority"]').value;
  const labels = { low: '低', medium: '中', high: '高' };
  result.textContent = `完成：${name}，优先级${labels[priority]}`;
  result.hidden = false;
});
