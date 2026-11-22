import { test, expect } from '@playwright/test';

async function createRoom(page: import('@playwright/test').Page, name: string) {
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Local Worker connected');
  await page.getByLabel('Room name').fill(name);
  await page.getByLabel('Owner name').fill('Rina');
  await page.getByRole('button', { name: 'Custom' }).click();
  await page.getByLabel('Access code (8 characters)').fill('room-access-code-2026');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return page.getByText(/^Room ID: r_[a-f0-9]{32}$/).innerText().then((text) => text.replace('Room ID: ', ''));
}

test('creates a room, shows the owner key once, and keeps credentials in memory', async ({ page }) => {
  const roomId = await createRoom(page, 'Stage 2 project room');
  expect(roomId).toMatch(/^r_[a-f0-9]{32}$/);
  const ownerKeyField = page.getByRole('textbox', { name: 'Owner key' });
  await expect(ownerKeyField).toBeVisible();
  const ownerKey = await ownerKeyField.inputValue();
  expect(ownerKey.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'I saved the owner key' }).click();
  await expect(ownerKeyField).toHaveCount(0);
  await expect(page.getByText('Rina · owner')).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('creates a real invitation, joins with it, refreshes the roster, changes role, and leaves', async ({ page, browser }) => {
  const roomId = await createRoom(page, 'Invitation room');
  await page.getByRole('button', { name: 'I saved the owner key' }).click();
  await page.getByLabel('Invitation role').selectOption('agent');
  await page.getByLabel('Invitation name (optional)').fill('Aster');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const invitation = page.getByLabel('Invitation token');
  await expect(invitation).toBeVisible();
  const token = await invitation.inputValue();
  expect(token.length).toBeGreaterThan(0);

  const guest = await browser.newPage();
  await guest.goto('./');
  await guest.getByLabel('Room ID', { exact: true }).fill(roomId);
  await guest.getByLabel('Your name').fill('Aster');
  await guest.getByLabel('Participant type').selectOption('agent');
  await guest.getByLabel('Credential type').selectOption('invitation');
  await guest.getByLabel('Invitation token').last().fill(token);
  await guest.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.getByRole('heading', { name: 'Invitation room' })).toBeVisible();
  await expect(guest.getByText('Aster · agent')).toBeVisible();

  await page.getByRole('button', { name: 'Refresh roster' }).click();
  await expect(page.getByText('Aster · agent')).toBeVisible();
  await page.getByLabel('Participant role for Aster').selectOption('observer');
  await page.getByRole('button', { name: 'Save role for Aster' }).click();
  await expect(page.getByText('Aster · observer')).toBeVisible();

  await guest.getByRole('button', { name: 'Leave room' }).click();
  await expect(guest.getByRole('heading', { name: 'Rooms' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh roster' }).click();
  await expect(page.getByText('Aster · observer')).toHaveCount(0);
  await guest.close();
});

test('recovers owner access, updates settings, rotates and disables the access code, then deletes the room', async ({ page, browser }) => {
  const roomId = await createRoom(page, 'Recoverable room');
  const ownerKey = await page.getByRole('textbox', { name: 'Owner key' }).inputValue();
  await page.getByRole('button', { name: 'I saved the owner key' }).click();

  const recovered = await browser.newPage();
  await recovered.goto('./');
  await recovered.getByLabel('Room ID to recover').fill(roomId);
  await recovered.getByLabel('Owner key for recovery').fill(ownerKey);
  await recovered.getByRole('button', { name: 'Recover owner access' }).click();
  await expect(recovered.getByRole('heading', { name: 'Recoverable room' })).toBeVisible();
  await expect(recovered.getByText('Rina · owner')).toBeVisible();

  await recovered.getByLabel('Room name setting').fill('Updated room');
  await recovered.getByLabel('Room description setting').fill('Updated through the real API');
  await recovered.getByLabel('Room access mode').selectOption('public');
  await recovered.getByRole('button', { name: 'Save room settings' }).click();
  await expect(recovered.getByRole('heading', { name: 'Updated room' })).toBeVisible();
  await recovered.getByLabel('New access code').fill('rotated-access-code-2026');
  await recovered.getByRole('button', { name: 'Rotate access code' }).click();
  await expect(recovered.getByText('Access code updated.')).toBeVisible();
  await recovered.getByRole('button', { name: 'Disable access code' }).click();
  await expect(recovered.getByText('Access code disabled.')).toBeVisible();

  await recovered.getByRole('button', { name: 'Delete room' }).click();
  await expect(recovered.getByRole('heading', { name: 'Rooms' })).toBeVisible();
  await expect(recovered.getByText('Room deleted.')).toBeVisible();
  await page.goto('./');
  await page.getByLabel('Room ID to recover').fill(roomId);
  await page.getByLabel('Owner key for recovery').fill(ownerKey);
  await page.getByRole('button', { name: 'Recover owner access' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid or expired');
  await recovered.close();
});

test('joins through the room ID and access code in an independent guest context and reports credential errors', async ({ page, browser }) => {
  const roomId = await createRoom(page, 'Code join room');
  await page.getByRole('button', { name: 'I saved the owner key' }).click();

  const guestContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5173/agent-commons/' });
  const guest = await guestContext.newPage();
  await guest.goto('./');
  await guest.getByLabel('Room ID', { exact: true }).fill(roomId);
  await guest.getByLabel('Your name').fill('Guest');
  await guest.getByLabel('Participant type').selectOption('human');
  await guest.getByLabel('Credential type').selectOption('access-code');
  await guest.getByLabel('Access code to join').fill('incorrect-access-code');
  await guest.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.getByRole('alert')).toContainText('invalid or expired');
  await guest.getByLabel('Access code to join').fill('room-access-code-2026');
  await guest.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.getByRole('heading', { name: 'Code join room' })).toBeVisible();
  await expect(guest.getByText('Guest · human')).toBeVisible();
  expect(await guest.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  await guest.getByRole('button', { name: 'Leave room' }).click();
  await expect(guest.getByRole('heading', { name: 'Rooms' })).toBeVisible();
  await guestContext.close();
});

 test('room actions remain usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Local Worker connected');
  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
