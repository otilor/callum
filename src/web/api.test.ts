import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api.js';

const fetchMock = vi.fn();

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function lastCall(): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
  return { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('reads state', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, { demo: false })));
    expect(await api.state()).toEqual({ demo: false });
    expect(lastCall()).toMatchObject({ url: '/api/state', method: 'GET' });
  });

  it('posts JSON and uses the exact routes', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, {})));
    await api.connect('email', { provider: 'google', address: 'a@b.co', password: 'x' });
    expect(lastCall()).toEqual({ url: '/api/channels/email/connect', method: 'POST', body: { provider: 'google', address: 'a@b.co', password: 'x' } });
    await api.microsoftStart('a@b.co');
    expect(lastCall()).toEqual({ url: '/api/channels/email/microsoft/start', method: 'POST', body: { address: 'a@b.co' } });
    await api.microsoftPoll('a@b.co');
    expect(lastCall()).toEqual({ url: '/api/channels/email/microsoft/poll', method: 'POST', body: { address: 'a@b.co' } });
    await api.resumeChannel('linkedin', 'half');
    expect(lastCall()).toEqual({ url: '/api/channels/linkedin/resume', method: 'POST', body: { pace: 'half' } });
    await api.resumeChannel('linkedin', 'half', true);
    expect(lastCall()).toEqual({ url: '/api/channels/linkedin/resume', method: 'POST', body: { pace: 'half', checked: true } });
    await api.retry(9);
    expect(lastCall()).toEqual({ url: '/api/outbox/9/retry', method: 'POST', body: {} });
    await api.retry(9, true);
    expect(lastCall()).toEqual({ url: '/api/outbox/9/retry', method: 'POST', body: { again: true } });
    await api.editBlocked(9, 'The pilot is 400 dollars.');
    expect(lastCall()).toEqual({ url: '/api/outbox/9/edit', method: 'POST', body: { body: 'The pilot is 400 dollars.' } });
    await api.editBlocked(9, 'The pilot is 400 dollars.', 'Following up');
    expect(lastCall()).toEqual({ url: '/api/outbox/9/edit', method: 'POST', body: { body: 'The pilot is 400 dollars.', subject: 'Following up' } });
    await api.dismissIncident(5);
    expect(lastCall()).toMatchObject({ url: '/api/incidents/5/dismiss', method: 'POST' });
    await api.importLeads({ paste: 'Kemi', projectId: 3 });
    expect(lastCall()).toEqual({ url: '/api/leads/import', method: 'POST', body: { paste: 'Kemi', projectId: 3 } });
    await api.search('founders', 25, 3);
    expect(lastCall()).toEqual({ url: '/api/leads/search', method: 'POST', body: { query: 'founders', count: 25, projectId: 3 } });
    await api.start(3);
    expect(lastCall()).toEqual({ url: '/api/start', method: 'POST', body: { projectId: 3 } });
    await api.approve(7, 'Hi Kemi');
    expect(lastCall()).toEqual({ url: '/api/outbox/7/approve', method: 'POST', body: { body: 'Hi Kemi' } });
    await api.snooze(4, '2026-11-09T08:00:00.000Z');
    expect(lastCall()).toEqual({ url: '/api/people/4/snooze', method: 'POST', body: { until: '2026-11-09T08:00:00.000Z' } });
    await api.correct(4, 'auto_reply');
    expect(lastCall()).toEqual({ url: '/api/people/4/correct', method: 'POST', body: { kind: 'auto_reply' } });
    await api.remove(4);
    expect(lastCall()).toMatchObject({ url: '/api/people/4/remove', method: 'POST' });
    await api.pause(null);
    expect(lastCall()).toEqual({ url: '/api/pause', method: 'POST', body: { until: null } });
    await api.wrap(true);
    expect(lastCall()).toEqual({ url: '/api/wrap', method: 'POST', body: { deleteData: true } });
    await api.createProject({ offer: 'You help teams run payroll.' });
    expect(lastCall()).toEqual({ url: '/api/projects', method: 'POST', body: { offer: 'You help teams run payroll.' } });
    await api.updateProject(2, { name: 'Payroll', tone: 'direct' });
    expect(lastCall()).toEqual({ url: '/api/projects/2', method: 'POST', body: { name: 'Payroll', tone: 'direct' } });
    await api.setCurrentProject(2);
    expect(lastCall()).toEqual({ url: '/api/projects/current', method: 'POST', body: { id: 2 } });
    await api.switchChannel(9, 'linkedin');
    expect(lastCall()).toEqual({ url: '/api/people/9/switch-channel', method: 'POST', body: { channel: 'linkedin' } });
    await api.switchChannel(9, 'x', '@kemi');
    expect(lastCall()).toEqual({ url: '/api/people/9/switch-channel', method: 'POST', body: { channel: 'x', handle: '@kemi' } });
    await api.moveToProject(9, 2);
    expect(lastCall()).toEqual({ url: '/api/people/9/move', method: 'POST', body: { projectId: 2 } });
    await api.seed('morning');
    expect(lastCall()).toEqual({ url: '/api/demo/seed', method: 'POST', body: { scene: 'morning' } });
  });

  it('puts GET parameters in the query string', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, { body: 'Hi' })));
    await api.sample('direct', 3);
    expect(lastCall().url).toBe('/api/sample?tone=direct&projectId=3');
    await api.sample('warm');
    expect(lastCall().url).toBe('/api/sample?tone=warm');
    await api.plan(3);
    expect(lastCall().url).toBe('/api/plan?projectId=3');
    await api.draft(8, 'booking');
    expect(lastCall().url).toBe('/api/people/8/draft?kind=booking');
    await api.suggestOffer();
    expect(lastCall().url).toBe('/api/offer/suggest');
  });

  it('throws ApiError with the server text and status', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply(422, { error: 'Connect a channel first' })));
    const err = await api.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, message: 'Connect a channel first' });
  });

  it('keeps retryAfter from a lockout', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply(429, { error: 'Too many tries. Try again in 42 s.', retryAfter: 42 })));
    const err = await api.login('nope').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, retryAfter: 42 });
  });

  it('turns an unreadable failure and a dropped connection into plain words', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await api.state().catch((e: unknown) => e)).toMatchObject({ status: 502, message: 'Something went wrong. Callum kept everything as it was.' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await api.state().catch((e: unknown) => e)).toMatchObject({ status: 0, message: "Callum can't be reached. Check that it is still running." });
  });
});
