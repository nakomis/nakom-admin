import { describe, it, expect, vi, afterEach } from 'vitest';
import { CvChatService, describeFailure } from './cvChatService';

afterEach(() => vi.unstubAllGlobals());

type Call = [string, RequestInit];

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
    const spy = vi.fn(impl);
    vi.stubGlobal('fetch', spy);
    // vi.fn's inferred call tuple widens to unknown[] once stubGlobal has
    // taken it, so the calls are read back through this rather than sprinkling
    // `as any` at each use site.
    return { spy, calls: () => spy.mock.calls as unknown as Call[] };
}

const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('CvChatService', () => {
    it('sends a Bearer access token and a JSON body', async () => {
        const { calls } = stubFetch(() => ok({ nodes: [], edges: [], applied_floor: 0.55, truncated: false }));
        await new CvChatService('https://api.cal.home.nakomis.com', 'tok').graph({ limit: 10 });

        const [url, init] = calls()[0];
        expect(url).toBe('https://api.cal.home.nakomis.com/cvchat/graph');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ limit: 10 });
    });

    it('does not double the slash when the base url has a trailing one', async () => {
        const { calls } = stubFetch(() => ok({}));
        await new CvChatService('https://api.cal.home.nakomis.com/', 'tok').stats();
        expect(calls()[0][0]).toBe('https://api.cal.home.nakomis.com/cvchat/stats');
    });

    it('sends an empty object when given no window, which the server reads as unbounded', async () => {
        const { calls } = stubFetch(() => ok({}));
        await new CvChatService('https://x', 'tok').stats();
        expect(JSON.parse(calls()[0][1].body as string)).toEqual({});
    });

    /**
     * The server's 401 body is deliberately opaque — an explaining 401 is an
     * oracle for probing tokens — so the meaning has to be supplied here or
     * the user sees nothing at all.
     */
    it('explains a 401 rather than showing the empty server reason', async () => {
        stubFetch(() => new Response('', { status: 401 }));
        await expect(new CvChatService('https://x', 'bad').stats())
            .rejects.toThrow(/access token was not accepted/);
    });

    it('distinguishes a 503 (endpoints down) from a 401 (token rejected)', async () => {
        stubFetch(() => new Response('', { status: 503 }));
        await expect(new CvChatService('https://x', 'tok').stats())
            .rejects.toThrow(/could not reach admin_analytics|no Cognito configuration/);
    });

    it('passes other statuses through with the body', async () => {
        stubFetch(() => new Response('since must be an RFC3339 timestamp', { status: 400 }));
        await expect(new CvChatService('https://x', 'tok').stats({ since: 'yesterday' }))
            .rejects.toThrow(/400 since must be an RFC3339/);
    });

    it('returns the parsed payload', async () => {
        stubFetch(() => ok({ nodes: [{ id: 'a' }], edges: [], applied_floor: 0.7, truncated: true }));
        const g = await new CvChatService('https://x', 'tok').graph();
        expect(g.nodes).toHaveLength(1);
        expect(g.applied_floor).toBe(0.7);
        expect(g.truncated).toBe(true);
    });

    it('defaults neighbours to k=10', async () => {
        const { calls } = stubFetch(() => ok({ neighbours: [] }));
        await new CvChatService('https://x', 'tok').neighbours('id-1');
        expect(JSON.parse(calls()[0][1].body as string)).toEqual({ id: 'id-1', k: 10 });
    });
});

describe('describeFailure', () => {
    /**
     * A missing client certificate, a box being off, and a CORS rejection are
     * all the same `TypeError: Failed to fetch` in the browser. Asserting one
     * of them would send someone debugging the wrong layer, so the message
     * lists them and says the browser cannot tell them apart.
     */
    it('names every cause of an opaque network failure rather than guessing one', () => {
        const msg = describeFailure(new TypeError('Failed to fetch'), 'https://api.cal.home.nakomis.com/cvchat/stats');
        expect(msg).toMatch(/client certificate/);
        expect(msg).toMatch(/home network or VPN/);
        expect(msg).toMatch(/down/);
        expect(msg).toMatch(/cannot tell these apart/);
    });

    it('recognises the Safari and Firefox wordings too', () => {
        for (const m of ['Load failed', 'NetworkError when attempting to fetch resource.']) {
            expect(describeFailure(new TypeError(m), 'https://x')).toMatch(/client certificate/);
        }
    });

    it('passes a specific error through unchanged', () => {
        expect(describeFailure(new Error('boom'), 'https://x')).toBe('boom');
    });
});
