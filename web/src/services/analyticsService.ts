import { Credentials } from '@aws-sdk/client-cognito-identity';
import Config from '../config/config';
import { createSignedFetcher, SignedFetcherOptions } from 'aws-sigv4-fetch';

export interface EmbeddingRecord {
    id: string;
    recorded_at: string;
    country: string | null;
    user_message: string;
    embedding: number[];
}

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
    getTimer() { return apiCall<{ shutdownAt: string | null }>(this.creds, '/rds/timer'); }
    extendTimer() { return apiCall<{ ok: boolean; shutdownAt: string }>(this.creds, '/rds/extend-timer', 'POST'); }
    importGenerate() { return apiCall<{ queued: number }>(this.creds, '/import/generate', 'POST'); }
    query(queryType: string, params?: object) { return apiCall<any[]>(this.creds, `/query/${queryType}`, 'POST', params); }

    async exportEmbeddings(): Promise<EmbeddingRecord[]> {
        const result = await apiCall<{ records?: EmbeddingRecord[]; s3_uri?: string }>(
            this.creds, '/query/embedding_export', 'POST'
        );
        if (result.records) return result.records;

        // Large payload: Lambda wrote to S3. Fetch it using our Cognito credentials.
        const uri = result.s3_uri!;
        const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
        if (!match) throw new Error(`Unexpected s3_uri format: ${uri}`);
        const [, bucket, key] = match;
        const url = `https://${bucket}.s3.${Config.aws.region}.amazonaws.com/${key}`;

        const signedFetch = createSignedFetcher({
            service: 's3',
            region: Config.aws.region,
            credentials: {
                accessKeyId: this.creds.AccessKeyId!,
                secretAccessKey: this.creds.SecretKey!,
                sessionToken: this.creds.SessionToken!,
            },
        });
        const res = await signedFetch(url);
        if (!res.ok) throw new Error(`S3 fetch failed: ${res.status}`);
        const { records } = await res.json();
        return records;
    }

    mineLogs(days: number) { return apiCall<any>(this.creds, '/logs/mine', 'POST', { days }); }
    getBlocklist() { return apiCall<any[]>(this.creds, '/blocklist'); }
    addToBlocklist(ip: string, reason: string) { return apiCall(this.creds, '/blocklist', 'POST', { action: 'add', ip, reason }); }
    removeFromBlocklist(ip: string) { return apiCall(this.creds, `/blocklist/${encodeURIComponent(ip)}`, 'DELETE'); }
}
