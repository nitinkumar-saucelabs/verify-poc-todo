/**
 * ?bug=flaky must stay flaky (9 Oct). Not in .sauce/config.yml: it pins the
 * variant's mechanism, whatever VARIANT the run is for.
 *
 * With every completion failing (flakeRate=1) the box still gets ticked — the
 * page drops the change silently — and the item is NOT done. On 8 Oct a
 * re-render on the failing path replaced the box, Playwright's check() retried
 * and re-rolled until a completion went through: the variant never failed.
 */
const { test, expect } = require('./fixtures');
const { appUrl } = require('./helpers');

test('a completion that silently fails leaves the box ticked and the todo not done', async ({ page }) => {
  const url = new URL(appUrl({ seed: 1, flakeRate: 1 }));
  url.searchParams.set('bug', 'flaky');
  await page.goto(url.toString());

  await page.getByTestId('toggle').check({ timeout: 3_000 });

  await expect(page.getByTestId('toggle')).toBeChecked();
  await expect(page.getByTestId('todo-item')).not.toHaveClass(/done/);
  await expect(page.getByTestId('count')).toHaveText('1 left');
});
