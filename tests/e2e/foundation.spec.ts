import { test, expect } from '@playwright/test';

test('web reports a response from the real local Worker', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('link', { name: 'Agent Commons home' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Local Worker connected');
  await expect(page.getByText('No participant or agent activity is simulated.')).toBeVisible();
});

test('does not claim a connection when the backend is unreachable', async ({ page }) => {
  await page.route('**/api/health', (route) => route.abort('connectionrefused'));
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Local Worker unavailable');
});

test('rejects an unrelated successful response instead of showing fake health', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }),
  }));
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Local Worker unavailable');
});

test('foundation remains usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Local Worker connected');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
