const { test, expect } = require('./fixtures');
const { openApp } = require('./helpers');

test('todos survive a reload', async ({ page }) => {
  await openApp(page, { seed: 2 });
  await expect(page.getByTestId('todo-item')).toHaveCount(2);

  await page.reload();

  await expect(page.getByTestId('todo-item')).toHaveCount(2);
});
