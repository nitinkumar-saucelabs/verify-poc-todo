const { test, expect } = require('./fixtures');
const { openApp } = require('./helpers');

// Fails under ?bug=app (backend rejects) and ?bug=selector (button renamed).
test('adding a todo puts it in the list', async ({ page }) => {
  await openApp(page);

  await page.getByTestId('new-input').fill('Buy milk');
  await page.getByTestId('submit-button').click();

  await expect(page.getByTestId('todo-item')).toHaveCount(1);
  await expect(page.getByTestId('todo-title')).toHaveText('Buy milk');
});
