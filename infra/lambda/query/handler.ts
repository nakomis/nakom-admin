import { Client as PgClient } from 'pg';

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

export const handler = async (event: { queryType: string; params?: any }) => {
    const db = await getDb();

    switch (event.queryType) {
        case 'similarity_graph': {
            // Returns pairs of chat_log IDs with cosine similarity above threshold
            const threshold = event.params?.threshold ?? 0.85;
            const limit = event.params?.limit ?? 500;
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
            return rows.rows;
        }

        case 'nodes': {
            // All chat log nodes for the graph (without embeddings — too large)
            const rows = await db.query(`
                SELECT id, conversation_id, recorded_at, ip, country,
                       user_message, message_count, tools_called,
                       input_tokens + output_tokens AS total_tokens
                FROM chat_logs
                ORDER BY recorded_at DESC
                LIMIT 1000
            `);
            return rows.rows;
        }

        case 'tool_usage': {
            const rows = await db.query(`
                SELECT unnest(tools_called) AS tool, count(*) AS uses
                FROM chat_logs
                WHERE tools_called IS NOT NULL
                GROUP BY 1
                ORDER BY 2 DESC
            `);
            return rows.rows;
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
            return rows.rows;
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
            return rows.rows;
        }

        default:
            return { error: `Unknown queryType: ${event.queryType}` };
    }
};
