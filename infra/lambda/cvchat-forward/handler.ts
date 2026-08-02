/**
 * Forwards cv.nakomis.com chat logs from DynamoDB to the home estate (ADMIN-6).
 *
 * Replaces import-generate, which embedded each record with Bedrock Titan and
 * staged it in S3 for import-execute to write into Aurora. All three of those
 * go away:
 *
 *   before:  DynamoDB -> Bedrock (Titan) -> S3 -> import-execute -> Aurora
 *   after:   DynamoDB -> SQS -> Cal (Ollama mxbai) -> Luke pgvector
 *
 * **Why the embedding moves.** Not to save the Bedrock spend, though it does.
 * The estate now has exactly one embedding model — mxbai-embed-large (q8) on
 * Cal — and vectors from two different models cannot be compared. Titan and
 * mxbai are both 1024 dimensions, which is the trap: the column types match,
 * nothing errors, and cosine distances between them are numbers that look
 * entirely plausible and mean nothing. Keeping one model is the invariant;
 * this Lambda not having a model is how that invariant is enforced rather than
 * remembered.
 *
 * **What travels.** An age-encrypted payload and an opaque id. This record
 * carries `ip`, `userAgent`, `country` and `userMessage` — personal data about
 * visitors to a public website, not about the operator — so none of it is
 * legible to AWS at rest in the queue. See cvchat-wire's module docs for the
 * envelope contract; this file is the other end of it.
 *
 * **Idempotent by construction.** The consumer upserts on `id`, so a
 * redelivery, a re-run after a partial failure, or a full replay of the corpus
 * (ADMIN-7) all converge on the same rows. That is what lets the cursor
 * advance optimistically below.
 */
import { DynamoDBClient, QueryCommand, type QueryCommandOutput } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});
const sqs = new SQSClient({});
const s3 = new S3Client({});

const LOG_TYPE = 'CVCHAT';

/** Envelope version. Bump only for a breaking change to the envelope itself. */
const ENVELOPE_VERSION = 1;

/**
 * Below SQS's 256 KB hard limit, leaving room for the base64 expansion, the
 * age header and the message attributes. Matches the `max-inline-bytes` SSM
 * parameter CvChatIngestStack publishes.
 */
const MAX_INLINE_BYTES = 200_000;

/** SQS caps a SendMessageBatch at ten entries. Not a tunable. */
const SQS_BATCH_MAX = 10;

/**
 * One record as it goes on the wire. Mirrors `CvChatJob` in
 * home-servers/cal/cvchat-wire — snake_case, because that crate is the
 * contract and serde is what has to parse this.
 *
 * Optional fields are *omitted* rather than sent as null. The consumer's
 * upsert COALESCEs on absence, so a literal null would clobber a value a
 * previous delivery had already stored.
 */
interface CvChatJob {
    id: string;
    log_type: string;
    conversation_id?: string;
    recorded_at: string;
    ip?: string;
    user_agent?: string;
    country?: string;
    user_message?: string;
    message_count?: number;
    tools_called?: string[];
    input_tokens?: number;
    output_tokens?: number;
    duration_ms?: number;
    rate_limited?: boolean;
}

/** Set a field only when there is a value — see CvChatJob's note on nulls. */
function put<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
    if (value !== undefined && value !== null) target[key] = value;
}

/**
 * A DynamoDB `N` attribute, or undefined when absent or unparseable.
 *
 * import-generate used `parseInt(x ?? '0')`, which turned every absent count
 * into a real zero. That is wrong in both directions: it invents data the
 * record never had, and — because the consumer COALESCEs — a zero *does*
 * overwrite a stored value where an absence would not.
 */
export function num(attr: { N?: string } | undefined): number | undefined {
    if (attr?.N === undefined) return undefined;
    const n = Number(attr.N);
    return Number.isFinite(n) ? n : undefined;
}

/** A DynamoDB `S` attribute, treating empty and whitespace-only as absent. */
export function str(attr: { S?: string } | undefined): string | undefined {
    const s = attr?.S;
    return s !== undefined && s.trim() !== '' ? s : undefined;
}

/**
 * The timestamp half of a `cv-chat-logs` sort key.
 *
 * The key is `${new Date().toISOString()}#${randomUUID()}` — see
 * nakom.is/lambda/chat/chat-logger.ts, which is the only writer. The uuid is
 * there to keep two requests in the same millisecond from colliding; it is not
 * part of the instant, so it has to come off before this reaches a
 * `TIMESTAMPTZ` column.
 *
 * Deliberately not `now`: after an outage the two differ by days, and letting
 * Postgres default the column would silently rewrite history.
 */
export function recordedAtFromSk(sk: string): string {
    const hash = sk.indexOf('#');
    return hash === -1 ? sk : sk.slice(0, hash);
}

/**
 * Map one DynamoDB item to the wire type.
 */
export function toJob(item: Record<string, any>): CvChatJob {
    const id = item.sk?.S;
    if (!id) throw new Error('item has no sort key');

    const job: CvChatJob = {
        id,
        log_type: item.logType?.S ?? LOG_TYPE,
        recorded_at: recordedAtFromSk(id),
    };
    put(job, 'conversation_id', str(item.conversationId));
    put(job, 'ip', str(item.ip));
    put(job, 'user_agent', str(item.userAgent));
    put(job, 'country', str(item.country));
    put(job, 'user_message', str(item.userMessage));
    put(job, 'message_count', num(item.messageCount));
    put(job, 'input_tokens', num(item.inputTokens));
    put(job, 'output_tokens', num(item.outputTokens));
    put(job, 'duration_ms', num(item.durationMs));
    if (item.rateLimited?.BOOL !== undefined) job.rate_limited = item.rateLimited.BOOL;

    // DynamoDB writes a string set as SS but a list as L; the table has been
    // written by more than one version of the chat backend, so accept both
    // rather than silently dropping tool names from the older shape.
    const tools = item.toolsCalled?.SS ?? item.toolsCalled?.L?.map((e: any) => e.S).filter(Boolean);
    if (tools && tools.length > 0) job.tools_called = tools;

    return job;
}

/**
 * Encrypt to the consumer's age recipient and wrap in the envelope.
 *
 * Oversized payloads go to S3 under the pipeline's own `cvchat/` prefix and
 * the envelope carries a pointer instead — the claim-check pattern
 * conversation-memory already uses. A cv chat record is a few KB, so this path
 * is unlikely ever to fire; it exists so both pipelines have the same shape
 * and the same failure modes.
 */
export async function buildEnvelope(
    job: CvChatJob,
    encrypter: { encrypt(data: Uint8Array): Promise<Uint8Array> },
    payloadBucket: string,
    putToS3: (key: string, body: Uint8Array) => Promise<void>,
): Promise<{ v: number; id: string; ciphertext?: string; s3?: { bucket: string; key: string } }> {
    const plaintext = new TextEncoder().encode(JSON.stringify(job));
    const ciphertext = await encrypter.encrypt(plaintext);
    const b64 = Buffer.from(ciphertext).toString('base64');

    if (b64.length <= MAX_INLINE_BYTES) {
        return { v: ENVELOPE_VERSION, id: job.id, ciphertext: b64 };
    }

    // The *ciphertext* goes to S3, not the plaintext. The whole point of the
    // age layer is that AWS never holds anything legible, and an object store
    // is no more trusted than a queue.
    const key = `cvchat/${job.id}.age`;
    await putToS3(key, ciphertext);
    return { v: ENVELOPE_VERSION, id: job.id, s3: { bucket: payloadBucket, key } };
}

export const handler = async () => {
    const queueUrl = process.env.CVCHAT_QUEUE_URL!;
    const cursorParam = process.env.IMPORT_CURSOR_PARAM!;
    const payloadBucket = process.env.PAYLOAD_BUCKET!;
    const recipient = process.env.AGE_RECIPIENT!;
    const table = process.env.CHAT_LOGS_TABLE ?? 'cv-chat-logs';

    if (!recipient) throw new Error('AGE_RECIPIENT is required — refusing to forward in the clear');

    // Imported dynamically because `age-encryption` is ESM-only and this
    // package's jest runs CommonJS. It is used nowhere but here — the pure
    // functions above take an encrypter as a parameter — so a lazy import
    // keeps the unit tests loadable without either an ESM jest config or a
    // stub standing in for the crypto.
    //
    // Nothing is lost by not exercising the real library here: what actually
    // needs proving is that its output decrypts with the Rust `age` crate on
    // Cal, and no test in this package could show that. That lives in
    // home-servers/cal/embedding-consumer/src/identity.rs, against a
    // ciphertext this library really produced.
    //
    // esbuild bundles the dynamic import at build time, so the Lambda still
    // ships one file with no runtime resolution.
    const age = await import('age-encryption');
    const encrypter = new age.Encrypter();
    encrypter.addRecipient(recipient);

    const cursorResult = await ssm.send(new GetParameterCommand({ Name: cursorParam }));
    const cursor = cursorResult.Parameter!.Value!;

    // No FilterExpression. import-generate carried `attribute_exists(
    // userMessage)` with the comment "skip SMS_SENT sentinel records (they
    // share the same PK)", and that was wrong on both halves: SMS_SENT is its
    // own `logType`, so the key condition below already excludes it, and every
    // CVCHAT record the chat backend writes carries a userMessage. The filter
    // was doing nothing it claimed to do — and had the sentinel really shared
    // the partition, filtering it out *after* the read would still have let
    // the cursor advance past it.
    //
    // Dropping it also means an event-shaped record with no message would now
    // be forwarded, which is what the console wants: the consumer stores it
    // with a NULL embedding and counts it.
    //
    // Paginate. import-generate issued a single Query and took whatever came
    // back, which silently caps a run at one 1 MB page — invisible while the
    // backlog is small and permanently lossy once it is not, because the
    // cursor still advanced past everything it *did* read.
    const items: Record<string, any>[] = [];
    let lastKey: QueryCommandOutput['LastEvaluatedKey'];
    do {
        const page: QueryCommandOutput = await ddb.send(new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'logType = :lt AND sk > :cursor',
            ExpressionAttributeValues: {
                ':lt': { S: LOG_TYPE },
                ':cursor': { S: cursor },
            },
            ExclusiveStartKey: lastKey,
        }));
        items.push(...(page.Items ?? []));
        lastKey = page.LastEvaluatedKey;
    } while (lastKey);

    if (items.length === 0) return { forwarded: 0, cursor };

    // Ascending, so a partial failure leaves the cursor at a point every
    // record before which really was sent.
    items.sort((a, b) => (a.sk?.S ?? '').localeCompare(b.sk?.S ?? ''));

    let forwarded = 0;
    let failed = 0;
    let newCursor = cursor;

    for (let i = 0; i < items.length; i += SQS_BATCH_MAX) {
        const slice = items.slice(i, i + SQS_BATCH_MAX);
        const entries = [];
        for (const item of slice) {
            const job = toJob(item);
            const envelope = await buildEnvelope(job, encrypter, payloadBucket, async (key, body) => {
                await s3.send(new PutObjectCommand({
                    Bucket: payloadBucket,
                    Key: key,
                    Body: body,
                    ContentType: 'application/age',
                }));
            });
            entries.push({
                // Batch-local only: SQS requires uniqueness within the batch,
                // not globally. Deduplication is the consumer's upsert, not
                // this id.
                Id: `m${entries.length}`,
                MessageBody: JSON.stringify(envelope),
            });
        }

        const result = await sqs.send(new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: entries,
        }));

        const failedIds = new Set((result.Failed ?? []).map((f: { Id?: string }) => f.Id));
        if (failedIds.size > 0) {
            failed += failedIds.size;
            console.error('sqs batch had failures', JSON.stringify(result.Failed));
        }
        // The cursor may only pass records that actually made it. A partial
        // batch failure therefore stops the advance dead rather than skipping
        // the failures — re-sending a delivered record is free (the consumer
        // upserts), whereas stepping over an undelivered one loses it for good.
        let stop = false;
        for (let j = 0; j < entries.length && !stop; j++) {
            if (failedIds.has(entries[j].Id)) {
                stop = true;
                break;
            }
            forwarded++;
            const sk = slice[j].sk.S as string;
            if (sk > newCursor) newCursor = sk;
        }
        if (stop) break;
    }

    if (newCursor !== cursor) {
        await ssm.send(new PutParameterCommand({
            Name: cursorParam,
            Value: newCursor,
            Type: 'String',
            Overwrite: true,
        }));
    }
    return { forwarded, failed, cursor: newCursor };
};
