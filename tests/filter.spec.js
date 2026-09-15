const { test, expect } = require('./fixtures');
const { openApp } = require('./helpers');

// Also exercises the toggle, so it can flake under ?bug=flaky — deliberately:
// two tests failing on one root cause is what defect fingerprinting must group.
test('filters show active and completed todos separately', async ({ page }) => {
  await openApp(page, { seed: 2 });

  await page.getByTestId('toggle').first().check();

  await page.getByTestId('filter-active').click();
  await expect(page.getByTestId('todo-item')).toHaveCount(1);

  await page.getByTestId('filter-completed').click();
  await expect(page.getByTestId('todo-item')).toHaveCount(1);

  await page.getByTestId('filter-all').click();
  await expect(page.getByTestId('todo-item')).toHaveCount(2);
});
