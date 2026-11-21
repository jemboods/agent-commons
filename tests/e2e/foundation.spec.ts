import { test, expect } from '@playwright/test';

test('web reports a response from the real local Worker', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Agent Commons', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Worker lokal terhubung');
  await expect(page.getByText('Room dan chat belum tersedia.')).toBeVisible();
});

test('does not claim a connection when the backend is unreachable', async ({ page }) => {
  await page.route('**/api/health', (route) => route.abort('connectionrefused'));
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Worker lokal tidak tersedia');
});

test('rejects an unrelated successful response instead of showing fake health', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }),
  }));
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Worker lokal tidak tersedia');
});

test('foundation remains usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Worker lokal terhubung');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
