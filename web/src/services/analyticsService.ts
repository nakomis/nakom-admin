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

    getRdsStatus() { return apiCall<{ status: string; endpoint?: string }>(this.creds, '/rds/status'); }
    startRds() { return apiCall(this.creds, '/rds/start', 'POST'); }
    stopRds() { return apiCall(this.creds, '/rds/stop', 'POST'); }
    takeSnapshot() { return apiCall(this.creds, '/rds/snapshot', 'POST'); }
    listSnapshots() { return apiCall<any[]>(this.creds, '/rds/snapshots'); }
    restoreSnapshot() { return apiCall(this.creds, '/rds/restore', 'POST'); }
    importGenerate() { return apiCall<{ queued: number }>(this.creds, '/import/generate', 'POST'); }
    query(queryType: string, params?: object) { return apiCall<any[]>(this.creds, `/query/${queryType}`, 'POST', params); }
    mineLogs(days: number) { return apiCall<any>(this.creds, '/logs/mine', 'POST', { days }); }
    getBlocklist() { return apiCall<any[]>(this.creds, '/blocklist'); }
    addToBlocklist(ip: string, reason: string) { return apiCall(this.creds, '/blocklist', 'POST', { action: 'add', ip, reason }); }
    removeFromBlocklist(ip: string) { return apiCall(this.creds, `/blocklist/${encodeURIComponent(ip)}`, 'DELETE'); }
}
