import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client as PgClient } from 'pg';

const s3 = new S3Client({});

// Payload size threshold below which we return inline rather than via S3
const INLINE_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB

// Reuse DB connection across warm invocations
let pgClient: PgClient | null = null;

async function getDb(): Promise<PgClient> {
    if (pgClient) return pgClient;
    pgClient = new PgClient({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT ?? '5432'),
        database: process.env.DB_NAME ?? 'analytics',
        user: process.env.DB_USER ?? 'analytics',
        password: process.env.DB_PASS,
        ssl: { rejectUnauthorized: false },
    });
    await pgClient.connect();
    return pgClient;
}

export const handler = async (event: any) => {
    const isHttp = !!(event.rawPath && event.requestContext);

    // HTTP API: type comes from the path parameter, params from the JSON body
    const queryType: string = isHttp
        ? (event.pathParameters?.type ?? event.rawPath.split('/').pop())
        : event.queryType;

    const params: any = isHttp
        ? (event.body ? JSON.parse(event.body) : {})
        : (event.params ?? {});

    const ok = (data: any) => isHttp
        ? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
        : data;

    const err = (status: number, message: string) => isHttp
        ? { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) }
        : { error: message };

    try {
        const db = await getDb();

        switch (queryType) {
            case 'similarity_graph': {
                const threshold = params?.threshold ?? 0.85;
                const limit = params?.limit ?? 500;
                const rows = await db.query(`
                    SELECT a.id AS id_a, b.id AS id_b,
                           1 - (a.embedding <=> b.embedding) AS similarity,
                           a.user_message AS msg_a, b.user_message AS msg_b,
                           a.ip AS ip_a, b.ip AS ip_b
                    FROM chat_logs a
                    JOIN chat_logs b ON a.id < b.id
                    WHERE 1 - (a.embedding <=> b.embedding) > $1
                    LIMIT $2
                `, [threshold, limit]);
                return ok(rows.rows);
            }

            case 'nodes': {
                const rows = await db.query(`
                    SELECT id, conversation_id, recorded_at, ip, country,
                           user_message, message_count, tools_called,
                           input_tokens + output_tokens AS total_tokens
                    FROM chat_logs
                    ORDER BY recorded_at DESC
                    LIMIT 1000
                `);
                return ok(rows.rows);
            }

            case 'tool_usage': {
                const rows = await db.query(`
                    SELECT unnest(tools_called) AS tool, count(*) AS uses
                    FROM chat_logs
                    WHERE tools_called IS NOT NULL
                    GROUP BY 1
                    ORDER BY 2 DESC
                `);
                return ok(rows.rows);
            }

            case 'ip_activity': {
                const rows = await db.query(`
                    SELECT ip,
                           count(*) AS total_requests,
                           count(DISTINCT DATE(recorded_at)) AS active_days,
                           min(recorded_at) AS first_seen,
                           max(recorded_at) AS last_seen,
                           sum(CASE WHEN rate_limited THEN 1 ELSE 0 END) AS rate_limit_hits
                    FROM chat_logs
                    WHERE ip != 'unknown'
                    GROUP BY ip
                    ORDER BY total_requests DESC
                    LIMIT 200
                `);
                return ok(rows.rows);
            }

            case 'conversations': {
                const rows = await db.query(`
                    SELECT conversation_id, count(*) AS turns,
                           min(recorded_at) AS started, max(recorded_at) AS ended,
                           array_agg(user_message ORDER BY recorded_at) AS messages
                    FROM chat_logs
                    WHERE conversation_id IS NOT NULL
                    GROUP BY conversation_id
                    ORDER BY started DESC
                    LIMIT 100
                `);
                return ok(rows.rows);
            }

            case 'embedding_export': {
                // Fetch records with their embeddings for dimensionality-reduction visualisation.
                // pgvector returns the embedding column as a JSON-array string e.g. "[0.1,0.2,...]",
                // so we cast to text and parse on the way out.
                // user_message is truncated in SQL to avoid inflating the payload unnecessarily.
                const exportLimit = params?.limit ?? 5000;
                const rows = await db.query(`
                    SELECT id,
                           recorded_at,
                           country,
                           LEFT(user_message, 150) AS user_message,
                           embedding::text AS embedding
                    FROM chat_logs
                    ORDER BY recorded_at
                    LIMIT $1
                `, [exportLimit]);

                const records = rows.rows.map(r => ({
                    id:           r.id,
                    recorded_at:  r.recorded_at,
                    country:      r.country,
                    user_message: r.user_message,
                    embedding:    JSON.parse(r.embedding) as number[],
                }));

                const payload = JSON.stringify({ records });

                // Return inline if small enough, otherwise spill to S3
                if (Buffer.byteLength(payload) < INLINE_LIMIT_BYTES) {
                    return ok({ records });
                }

                const bucket = process.env.STAGING_BUCKET;
                if (!bucket) {
                    return err(500, 'STAGING_BUCKET not configured and payload exceeds inline limit');
                }

                const key = `embedding-export/${Date.now()}.json`;
                await s3.send(new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: payload,
                    ContentType: 'application/json',
                }));

                // Browser has Cognito credentials with S3 read access, so return the URI directly
                return ok({ s3_uri: `s3://${bucket}/${key}` });
            }

            default:
                return err(400, `Unknown queryType: ${queryType}`);
        }
    } catch (error) {
        console.error('Query error:', error);
        return err(500, error instanceof Error ? error.message : 'Unknown error');
    }
};
