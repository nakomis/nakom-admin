import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createGunzip } from 'zlib';
import * as readline from 'readline';

const s3 = new S3Client({});

// CloudFront log field indices (0-based, after stripping the 2 header lines)
const CF_IP = 4, CF_METHOD = 5, CF_URI_STEM = 7, CF_STATUS = 8;

const SCANNER_PATHS = ['.env', 'wp-admin', 'wp-login', 'phpmyadmin', '.git',
    'xmlrpc', 'shell.php', 'config.php', 'admin.php', '.aws'];

function isScanner(uri: string): boolean {
    return SCANNER_PATHS.some(p => uri.toLowerCase().includes(p));
}

export const handler = async (event: { days?: number }) => {
    const bucket = process.env.CF_LOGS_BUCKET!;
    const days = event.days ?? 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // List log files in time range
    const files: string[] = [];
    let token: string | undefined;
    do {
        const r = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'cf-logs/',
            ContinuationToken: token,
        }));
        for (const obj of r.Contents ?? []) {
            if (obj.LastModified && obj.LastModified >= since) {
                files.push(obj.Key!);
            }
        }
        token = r.NextContinuationToken;
    } while (token);

    // Aggregate by IP
    const ipStats = new Map<string, {
        total: number; scannerHits: number; errors: number; methods: Set<string>;
    }>();

    for (const key of files) {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const gunzip = createGunzip();
        const rl = readline.createInterface({ input: (obj.Body as any).pipe(gunzip) });

        for await (const line of rl) {
            if (line.startsWith('#')) continue; // CF log header lines
            const fields = line.split('\t');
            const ip = fields[CF_IP];
            const uri = fields[CF_URI_STEM] ?? '';
            const status = parseInt(fields[CF_STATUS] ?? '200');
            if (!ip || ip === '-') continue;

            const stats = ipStats.get(ip) ?? { total: 0, scannerHits: 0, errors: 0, methods: new Set() };
            stats.total++;
            if (isScanner(uri)) stats.scannerHits++;
            if (status >= 400) stats.errors++;
            stats.methods.add(fields[CF_METHOD] ?? 'GET');
            ipStats.set(ip, stats);
        }
    }

    // Score and rank
    const results = Array.from(ipStats.entries())
        .map(([ip, s]) => ({
            ip,
            totalRequests: s.total,
            scannerHitRate: s.total > 0 ? s.scannerHits / s.total : 0,
            errorRate: s.total > 0 ? s.errors / s.total : 0,
            flags: [
                s.scannerHits > 0 ? 'SCANNER' : null,
                s.total > 500 ? 'HIGH_VOLUME' : null,
            ].filter(Boolean),
        }))
        .filter(r => r.flags.length > 0 || r.totalRequests > 100)
        .sort((a, b) => b.totalRequests - a.totalRequests)
        .slice(0, 50);

    return { period: `last ${days} days`, filesScanned: files.length, suspects: results };
};
