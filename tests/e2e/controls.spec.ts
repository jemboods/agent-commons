import { test, expect, type Page } from '@playwright/test';

async function createRoom(page: Page, name: string) {
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Local Worker connected');
  await page.getByLabel('Room name').fill(name);
  await page.getByLabel('Owner name').fill('Rina');
  await page.getByLabel('Access code (at least 12 characters)').fill('room-controls-code-2026');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('Live chat connected')).toBeVisible();
  return page.getByText(/^Room ID: r_[a-f0-9]{32}$/).innerText().then((text) => text.replace('Room ID: ', ''));
}

async function joinAsGuest(page: Page, roomId: string, name: string) {
  await page.goto('./');
  await page.getByLabel('Room ID', { exact: true }).fill(roomId);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Access code to join').fill('room-controls-code-2026');
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.getByText('Live chat connected')).toBeVisible();
}

test('owner pauses the room and a guest send is rejected until resume', async ({ page, browser }) => {
  const roomId = await createRoom(page, 'Pause control room');
  await page.getByRole('button', { name: 'I saved the owner key' }).click();

  const guest = await browser.newPage();
  await joinAsGuest(guest, roomId, 'Aster');

  await page.getByRole('button', { name: 'Pause room' }).click();
  await expect(guest.getByText('Room paused by the owner. Sending is limited to the owner and moderators.')).toBeVisible();

  await guest.getByLabel('Message', { exact: true }).fill('Tidak terkirim saat pause');
  await guest.getByRole('button', { name: 'Send message' }).click();
  await expect(guest.getByText('The room is paused. Only the owner and moderators can send right now.')).toBeVisible();
  await expect(page.getByText('Tidak terkirim saat pause')).toHaveCount(0);

  await page.getByRole('button', { name: 'Resume room' }).click();
  await guest.getByLabel('Message', { exact: true }).fill('Sudah bisa kirim lagi');
  await guest.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Sudah bisa kirim lagi')).toBeVisible();
  await guest.close();
});

test('owner mutes a guest, pins a message, and broadcasts an announcement', async ({ page, browser }) => {
  const roomId = await createRoom(page, 'Mute pin broadcast room');
  await page.getByRole('button', { name: 'I saved the owner key' }).click();

  const guest = await browser.newPage();
  await joinAsGuest(guest, roomId, 'Aster');

  await guest.getByLabel('Message', { exact: true }).fill('Kalimat penting untuk dipin');
  await guest.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Kalimat penting untuk dipin')).toBeVisible();

  await page.getByRole('button', { name: 'Pin message from Aster' }).click();
  await expect(page.locator('[aria-label="Pinned messages"]')).toContainText('Kalimat penting untuk dipin');
  await expect(guest.locator('[aria-label="Pinned messages"]')).toContainText('Kalimat penting untuk dipin');

  await expect(page.getByRole('button', { name: 'Mute Aster' })).toBeVisible();
  await page.getByRole('button', { name: 'Mute Aster' }).click();
  await guest.getByLabel('Message', { exact: true }).fill('Suara yang dibisukan');
  await guest.getByRole('button', { name: 'Send message' }).click();
  await expect(guest.getByText('You are muted in this room, so your message was not sent.')).toBeVisible();
  await expect(page.getByText('Suara yang dibisukan')).toHaveCount(0);

  await page.getByRole('button', { name: 'Broadcast' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Pengumuman resmi owner');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(guest.getByText('Pengumuman resmi owner')).toBeVisible();
  await expect(guest.getByText('Broadcast', { exact: true })).toBeVisible();
  await guest.close();
});

test('owner removes a guest and the guest connection closes', async ({ page, browser }) => {
  const roomId = await createRoom(page, 'Remove control room');
  await page.getByRole('button', { name: 'I saved the owner key' }).click();

  const guest = await browser.newPage();
  await joinAsGuest(guest, roomId, 'Aster');

  await expect(page.getByRole('button', { name: 'Remove Aster' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Aster' }).click();
  await expect(guest.getByText('Live chat disconnected')).toBeVisible();

  await page.getByRole('button', { name: 'Refresh roster' }).click();
  await expect(page.getByText('Aster · human')).toHaveCount(0);
  await guest.close();
});
