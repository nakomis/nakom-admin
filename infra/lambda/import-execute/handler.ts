import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Client as PgClient } from 'pg';

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function getS3Json(bucket: string, key: string): Promise<any[]> {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await r.Body!.transformToString('utf-8');
    return JSON.parse(body);
}

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
        connectionTimeoutMillis: 10000,
    });
    await pgClient.connect();

    // Bootstrap schema on first connection
    await pgClient.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // Migration: drop table if it was created with the wrong embedding dimension
    await pgClient.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                WHERE c.relname = 'chat_logs' AND a.attname = 'embedding'
                  AND a.atttypmod <> 1024
            ) THEN
                DROP TABLE chat_logs;
            END IF;
        END $$;
    `);

    await pgClient.query(`
        CREATE TABLE IF NOT EXISTS chat_logs (
            id              TEXT PRIMARY KEY,
            log_type        TEXT NOT NULL,
            conversation_id TEXT,
            recorded_at     TIMESTAMPTZ NOT NULL,
            ip              TEXT,
            user_agent      TEXT,
            country         TEXT,
            user_message    TEXT,
            message_count   INT,
            tools_called    TEXT[],
            input_tokens    INT,
            output_tokens   INT,
            duration_ms     INT,
            rate_limited    BOOLEAN,
            embedding       vector(1024)
        )
    `);
    await pgClient.query(`
        CREATE INDEX IF NOT EXISTS chat_logs_embedding_idx
        ON chat_logs USING hnsw (embedding vector_cosine_ops)
    `);

    return pgClient;
}

export const handler = async (event: { stagingBucket: string; stagingKey: string }) => {
    const records = await getS3Json(event.stagingBucket, event.stagingKey);
    const db = await getDb();

    // Bulk insert with ON CONFLICT DO NOTHING (idempotent)
    for (const r of records) {
        // Extract timestamp from sk (format: "2026-02-26T10:15:00.000Z#uuid")
        const recordedAt = r.id.split('#')[0];
        const embeddingLiteral = `[${r.embedding.join(',')}]`;

        await db.query(`
            INSERT INTO chat_logs (id, log_type, conversation_id, recorded_at, ip, user_agent,
                country, user_message, message_count, tools_called, input_tokens, output_tokens,
                duration_ms, rate_limited, embedding)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector)
            ON CONFLICT (id) DO NOTHING
        `, [r.id, r.logType, r.conversationId, recordedAt, r.ip, r.userAgent,
            r.country, r.userMessage, r.messageCount, r.toolsCalled,
            r.inputTokens, r.outputTokens, r.durationMs, r.rateLimited,
            embeddingLiteral]);
    }

    return { inserted: records.length };
};
