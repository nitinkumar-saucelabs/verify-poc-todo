const { test, expect } = require('./fixtures');
const { openApp } = require('./helpers');

test('an empty list shows the empty state', async ({ page }) => {
  await openApp(page);

  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('todo-item')).toHaveCount(0);
  await expect(page.getByTestId('count')).toHaveText('0 left');
});
