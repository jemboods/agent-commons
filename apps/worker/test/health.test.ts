import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker foundation', () => {
  it('rejects non-GET health requests without reflecting input', async () => {
    const response = await SELF.fetch('https://example.com/api/health', { method: 'POST', body: 'sensitive-input' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(await response.text()).not.toContain('sensitive-input');
  });
  it('returns an explicit not-found response for unavailable features', async () => {
    const response = await SELF.fetch('https://example.com/api/rooms');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
  it('reports health from the actual Worker runtime', async () => {
    const response = await SELF.fetch('https://example.com/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'agent-commons', status: 'ok', stage: 1 });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
