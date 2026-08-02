/**
 * Client for the cv-chat analytics endpoints on Cal (ADMIN-8).
 *
 * A **second** API client alongside `analyticsService.ts`, because it talks to
 * a different service over a different transport with different auth:
 *
 *                    analyticsService          this
 *   origin           API Gateway (AWS)         api.cal.home.nakomis.com
 *   auth             SigV4, Cognito Identity   Cognito access token (Bearer)
 *   network gate     IAM                       mTLS client certificate
 *
 * Folding these into one client would mean a signing path that branches on the
 * URL, which is precisely the kind of thing that ends up signing a request
 * with the wrong credentials.
 *
 * **The mTLS certificate is not something this code can supply.** The browser
 * presents it during the TLS handshake with Leia, from the OS/browser keystore
 * — no fetch option controls it. That is deliberate: the tab is meant to work
 * only from a machine holding the client certificate, so the failure mode when
 * one is absent is a TLS-level rejection this code never sees as a normal HTTP
 * error. `describeFailure` below exists to turn that into something a human
 * can act on rather than a bare "Failed to fetch".
 */

/** Matches `GraphNode` in cal/embedding-consumer/src/analytics.rs. */
export interface CvChatNode {
    id: string;
    log_type: string;
    conversation_id: string | null;
    recorded_at: string;
    country: string | null;
    snippet: string | null;
    message_count: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    duration_ms: number | null;
    rate_limited: boolean | null;
    /** False for records with no text — an event, not a message. */
    embedded: boolean;
}

export interface CvChatEdge {
    source: string;
    target: string;
    similarity: number;
}

export interface CvChatGraph {
    nodes: CvChatNode[];
    edges: CvChatEdge[];
    /** The floor actually applied, after the server clamped it. */
    applied_floor: number;
    /** True when the node limit cut the result short. */
    truncated: boolean;
}

export interface CvChatDailyPoint {
    day: string;
    conversations: number;
    messages: number;
    input_tokens: number;
    output_tokens: number;
    rate_limited: number;
}

export interface CvChatStats {
    total_records: number;
    embedded_records: number;
    conversations: number;
    countries: number;
    total_input_tokens: number;
    total_output_tokens: number;
    rate_limited: number;
    duration_p50_ms: number | null;
    duration_p95_ms: number | null;
    daily: CvChatDailyPoint[];
    edges: number;
}

export interface CvChatNeighbour {
    id: string;
    similarity: number;
    snippet: string | null;
    recorded_at: string;
}

export interface GraphQuery {
    since?: string;
    until?: string;
    min_similarity?: number;
    limit?: number;
}

/**
 * Turn a fetch failure into something actionable.
 *
 * A missing or rejected client certificate surfaces as a `TypeError: Failed to
 * fetch` with no status — indistinguishable from the box being off, from DNS
 * failing, and from CORS. Guessing wrongly here sends someone debugging the
 * wrong layer for an hour, so this names the possibilities rather than
 * asserting one.
 */
export function describeFailure(error: unknown, endpoint: string): string {
    if (error instanceof Response) return `${endpoint} returned ${error.status}`;
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
        return (
            `Could not reach ${endpoint}. The request never got a response, which ` +
            `usually means one of: no client certificate installed in this browser ` +
            `(the endpoint requires mTLS), you are not on the home network or VPN, ` +
            `or Leia/Cal is down. The browser cannot tell these apart.`
        );
    }
    return message;
}

export class CvChatService {
    /**
     * @param baseUrl e.g. `https://api.cal.home.nakomis.com`. No trailing slash.
     * @param token   The Cognito **access** token (not the id token) — the
     *                consumer validates `token_use: access` against the pool.
     */
    constructor(private baseUrl: string, private token: string) {}

    private async post<T>(path: string, body: object): Promise<T> {
        const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.token}`,
                },
                body: JSON.stringify(body),
            });
        } catch (e) {
            throw new Error(describeFailure(e, url));
        }
        if (!res.ok) {
            // The 401 body is deliberately opaque server-side (an explaining
            // 401 is a probing oracle), so say what it means here instead of
            // showing the empty reason.
            if (res.status === 401) {
                throw new Error(
                    'Rejected by Cal: the access token was not accepted. Sign out and ' +
                    'back in; if it persists the consumer may not have Cognito configured.',
                );
            }
            if (res.status === 503) {
                throw new Error(
                    'Cal is up but the analytics endpoints are not: the consumer could ' +
                    'not reach admin_analytics or has no Cognito configuration.',
                );
            }
            const text = await res.text().catch(() => '');
            throw new Error(`${url} → ${res.status} ${text}`.trim());
        }
        return (await res.json()) as T;
    }

    stats(window: { since?: string; until?: string } = {}) {
        return this.post<CvChatStats>('/cvchat/stats', window);
    }

    graph(query: GraphQuery = {}) {
        return this.post<CvChatGraph>('/cvchat/graph', query);
    }

    neighbours(id: string, k = 10) {
        return this.post<{ neighbours: CvChatNeighbour[] }>('/cvchat/neighbours', { id, k });
    }
}
