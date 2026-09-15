const { test, expect } = require('./fixtures');
const { openApp } = require('./helpers');

test('deleting a todo removes it from the list', async ({ page }) => {
  await openApp(page, { seed: 1 });

  await expect(page.getByTestId('todo-item')).toHaveCount(1);
  await page.getByTestId('delete').click();

  await expect(page.getByTestId('todo-item')).toHaveCount(0);
  await expect(page.getByTestId('empty-state')).toBeVisible();
});
