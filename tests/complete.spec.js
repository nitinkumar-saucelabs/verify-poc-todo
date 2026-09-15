const { test, expect } = require('./fixtures');
const { openApp } = require('./helpers');

// Fails intermittently under ?bug=flaky (toggle silently does nothing).
test('completing a todo marks it done', async ({ page }) => {
  await openApp(page, { seed: 1 });

  await page.getByTestId('toggle').check();

  await expect(page.getByTestId('toggle')).toBeChecked();
  await expect(page.getByTestId('todo-item')).toHaveClass(/done/);
});
