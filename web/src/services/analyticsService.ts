import { Credentials } from '@aws-sdk/client-cognito-identity';
import Config from '../config/config';
import { createSignedFetcher, SignedFetcherOptions } from 'aws-sigv4-fetch';

async function apiCall<T>(creds: Credentials, path: string, method = 'GET', body?: object): Promise<T> {
    const options: SignedFetcherOptions = {
        service: 'execute-api',
        region: 'eu-west-2',
        credentials: {
            accessKeyId: creds.AccessKeyId!,
            secretAccessKey: creds.SecretKey!,
            sessionToken: creds.SessionToken!,
        },
        fetch: fetch,              // optional (defaults to native fetch)
    };

    const signedFetch = createSignedFetcher(options);

    const res = await signedFetch(`${Config.apiEndpoint}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(e => {
        console.error(`API call error: ${method} ${path}`, e);
        throw e;
    });
    if (!res.ok) throw new Error(`API ${method} ${path} → ${res.status}`);
    return res.json();
}

export class AnalyticsService {
    constructor(private creds: Credentials) {}

    /**
     * Kicks the cv-chat forwarder (ADMIN-6). Still POST /import/generate so
     * the button did not have to move; the Lambda behind it now enqueues for
     * Cal rather than embedding with Bedrock and writing to Aurora, so the
     * count is records *queued*, not records stored.
     */
    importGenerate() { return apiCall<{ forwarded: number; queued?: number }>(this.creds, '/import/generate', 'POST')
        .then(r => ({ queued: r.forwarded ?? r.queued ?? 0 })); }

    mineLogs(days: number) { return apiCall<any>(this.creds, '/logs/mine', 'POST', { days }); }
    getBlocklist() { return apiCall<any[]>(this.creds, '/blocklist'); }
    addToBlocklist(ip: string, reason: string) { return apiCall(this.creds, '/blocklist', 'POST', { action: 'add', ip, reason }); }
    removeFromBlocklist(ip: string) { return apiCall(this.creds, `/blocklist/${encodeURIComponent(ip)}`, 'DELETE'); }
}
