import { test, expect, type Page } from '@playwright/test';

async function createRoom(page: Page, name: string) {
  await page.goto('./');
  await expect(page.getByRole('status')).toHaveText('Local Worker connected');
  await page.getByLabel('Room name').fill(name);
  await page.getByLabel('Owner name').fill('Rina');
  await page.getByRole('button', { name: 'Custom' }).click();
  await page.getByLabel('Access code (8 characters)').fill('room-chat-code-2026');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('Live chat connected')).toBeVisible();
  return page.getByText(/^Room ID: r_[a-f0-9]{32}$/).innerText().then((text) => text.replace('Room ID: ', ''));
}

async function joinAsGuest(page: Page, roomId: string, name: string) {
  await page.goto('./');
  await page.getByLabel('Room ID', { exact: true }).fill(roomId);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Access code to join').fill('room-chat-code-2026');
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.getByText('Live chat connected')).toBeVisible();
}

test('relays live chat, replies, mentions, typing and presence between two browsers', async ({ page, browser }) => {
  const roomId = await createRoom(page, 'Live chat room');
  await page.getByRole('button', { name: 'I saved the owner key' }).click();
  await expect(page.getByLabel('Rina online')).toBeVisible();

  const guest = await browser.newPage();
  await joinAsGuest(guest, roomId, 'Aster');
  await expect(page.getByLabel('Aster online')).toBeVisible();

  await page.getByLabel('Message', { exact: true }).fill('Halo dari owner');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(guest.getByText('Halo dari owner')).toBeVisible();
  await expect(page.getByText('Halo dari owner')).toBeVisible();

  await guest.getByRole('button', { name: 'Reply to message from Rina' }).click();
  await guest.getByLabel('Message', { exact: true }).fill('Balasan untuk owner');
  await guest.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Balasan untuk owner')).toBeVisible();
  await expect(page.getByText('Replying to Rina: Halo dari owner')).toBeVisible();

  await page.getByRole('button', { name: 'Mention Aster' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Cek ini, Aster');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(guest.getByText('Cek ini, Aster')).toBeVisible();
  await expect(guest.getByText('Mentions: Aster')).toBeVisible();

  await guest.getByLabel('Message', { exact: true }).fill('sedang menulis');
  await expect(page.getByText(/Aster is typing/)).toBeVisible();

  await guest.close();
  await expect(page.getByLabel('Aster offline')).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('rejects a browser send after the participant becomes an observer', async ({ page, browser }) => {
  const roomId = await createRoom(page, 'Observer chat room');
  await page.getByRole('button', { name: 'I saved the owner key' }).click();

  const guest = await browser.newPage();
  await joinAsGuest(guest, roomId, 'Bima');
  await page.getByRole('button', { name: 'Refresh roster' }).click();
  await expect(page.getByText('Bima · human')).toBeVisible();
  await page.getByLabel('Participant role for Bima').selectOption('observer');
  await page.getByRole('button', { name: 'Save role for Bima' }).click();
  await expect(page.getByText('Bima · observer')).toBeVisible();

  await guest.getByLabel('Message', { exact: true }).fill('Mencoba mengirim sebagai observer');
  await guest.getByRole('button', { name: 'Send message' }).click();
  await expect(guest.getByText('You cannot send messages with your current role.')).toBeVisible();
  await expect(page.getByText('Mencoba mengirim sebagai observer')).toHaveCount(0);
  await guest.close();
});
