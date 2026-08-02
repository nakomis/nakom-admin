import { toJob, num, str, recordedAtFromSk, buildEnvelope } from './handler';

/**
 * A DynamoDB item in the shape nakom.is/lambda/chat/chat-logger.ts actually
 * writes. Copied from that writer rather than invented, because the whole
 * class of bug this file exists to catch is the mapping drifting from what
 * the producer emits.
 */
function item(overrides: Record<string, any> = {}) {
    return {
        logType: { S: 'CVCHAT' },
        sk: { S: '2026-02-26T22:34:13.501Z#5cd7db13-09c5-4a06-a45e-92f0b17d635e' },
        conversationId: { S: 'e864ee11-5b92-4e38-ba65-3c7e86e701b5' },
        ip: { S: '193.237.192.25' },
        userAgent: { S: 'Amazon CloudFront' },
        country: { S: 'unknown' },
        userMessage: { S: 'Tell me about your GitHub projects' },
        messageCount: { N: '3' },
        toolsCalled: { SS: ['get_github_readme'] },
        inputTokens: { N: '0' },
        outputTokens: { N: '377' },
        durationMs: { N: '5241' },
        rateLimited: { BOOL: false },
        ttl: { N: '1801000000' },
        ...overrides,
    };
}

describe('recordedAtFromSk', () => {
    /**
     * The sort key is `${isoTimestamp}#${uuid}`. Sending the whole thing as
     * recorded_at gives Postgres a string it cannot cast, and the record dies
     * in the DLQ — which is how this was nearly shipped.
     */
    it('takes the timestamp half of the sort key', () => {
        expect(recordedAtFromSk('2026-02-26T22:34:13.501Z#5cd7db13')).toBe('2026-02-26T22:34:13.501Z');
    });

    it('leaves a bare timestamp alone', () => {
        expect(recordedAtFromSk('2026-02-26T22:34:13.501Z')).toBe('2026-02-26T22:34:13.501Z');
    });

    it('keeps the id itself intact — it is the primary key, uuid and all', () => {
        const job = toJob(item());
        expect(job.id).toBe('2026-02-26T22:34:13.501Z#5cd7db13-09c5-4a06-a45e-92f0b17d635e');
        expect(job.recorded_at).toBe('2026-02-26T22:34:13.501Z');
    });
});

describe('attribute readers', () => {
    /**
     * import-generate used `parseInt(x ?? '0')`. An absent count became a real
     * zero — data the record never had, and because the consumer COALESCEs, a
     * zero overwrites a stored value where an absence would not.
     */
    it('reports an absent number as absent, not as zero', () => {
        expect(num(undefined)).toBeUndefined();
        expect(num({})).toBeUndefined();
        expect(num({ N: '0' })).toBe(0);
    });

    it('rejects an unparseable number rather than passing NaN down the wire', () => {
        expect(num({ N: 'banana' })).toBeUndefined();
    });

    it('treats an empty or whitespace string as absent', () => {
        expect(str({ S: '' })).toBeUndefined();
        expect(str({ S: '   ' })).toBeUndefined();
        expect(str({ S: 'GB' })).toBe('GB');
    });
});

describe('toJob', () => {
    it('maps every column the consumer upserts', () => {
        const job = toJob(item());
        expect(job).toMatchObject({
            log_type: 'CVCHAT',
            conversation_id: 'e864ee11-5b92-4e38-ba65-3c7e86e701b5',
            ip: '193.237.192.25',
            user_agent: 'Amazon CloudFront',
            country: 'unknown',
            user_message: 'Tell me about your GitHub projects',
            message_count: 3,
            tools_called: ['get_github_readme'],
            input_tokens: 0,
            output_tokens: 377,
            duration_ms: 5241,
            rate_limited: false,
        });
    });

    /**
     * Absent, not null. The consumer's upsert COALESCEs, so a literal null
     * clobbers whatever a previous delivery of the same id already stored —
     * which would make a replay destructive instead of idempotent.
     */
    it('omits missing optionals entirely rather than sending null', () => {
        const job = toJob(item({ country: undefined, messageCount: undefined, rateLimited: undefined }));
        expect('country' in job).toBe(false);
        expect('message_count' in job).toBe(false);
        expect('rate_limited' in job).toBe(false);
    });

    /** `false` is a value, not an absence — and it is the common case. */
    it('keeps a false rate_limited', () => {
        expect(toJob(item()).rate_limited).toBe(false);
        expect(toJob(item({ rateLimited: { BOOL: true } })).rate_limited).toBe(true);
    });

    /**
     * The writer uses a Set (DynamoDB SS), but the table has been written by
     * more than one version of the backend. Accepting L as well costs nothing
     * and avoids silently dropping tool names from the older shape.
     */
    it('accepts tools as a string set or a list', () => {
        expect(toJob(item()).tools_called).toEqual(['get_github_readme']);
        expect(toJob(item({ toolsCalled: { L: [{ S: 'a' }, { S: 'b' }] } })).tools_called).toEqual(['a', 'b']);
    });

    /** An empty tool list and no tool list mean the same thing. */
    it('omits an empty tools list', () => {
        expect('tools_called' in toJob(item({ toolsCalled: { SS: [] } }))).toBe(false);
        expect('tools_called' in toJob(item({ toolsCalled: undefined }))).toBe(false);
    });

    /**
     * A record with no message is an event — a rate-limit hit, a session
     * start. It must still forward: the consumer stores it with a NULL
     * embedding and the console counts it. import-generate's FilterExpression
     * would have dropped it.
     */
    it('forwards a record with no user message', () => {
        const job = toJob(item({ userMessage: undefined }));
        expect('user_message' in job).toBe(false);
        expect(job.id).toBeTruthy();
    });

    /** ttl is DynamoDB's own expiry mechanism and has no column on Luke. */
    it('does not put ttl on the wire', () => {
        expect('ttl' in toJob(item())).toBe(false);
    });

    it('refuses an item with no sort key rather than inventing one', () => {
        expect(() => toJob(item({ sk: undefined }))).toThrow('no sort key');
    });
});

describe('buildEnvelope', () => {
    /**
     * A stub that genuinely transforms its input — XOR against a constant.
     * An identity-ish stub (`[0xff, ...d]`) makes the "did plaintext leak?"
     * assertions below pass or fail on a property of the *stub* rather than
     * of the code, which is the trap this comment exists to keep the next
     * person out of. The real library's output is proven interoperable by the
     * Rust test named in handler.ts.
     */
    const encrypter = {
        encrypt: async (d: Uint8Array) => Uint8Array.from(d, (b) => b ^ 0x5a),
    };

    /**
     * The envelope is what AWS can read. Everything about the visitor — ip,
     * user agent, message — must be inside the ciphertext, leaving only an
     * opaque id. This asserts the exact key set, so adding a field to the
     * envelope has to be a deliberate act with a failing test in front of it.
     */
    it('leaks nothing but the id', async () => {
        const job = toJob(item());
        const env = await buildEnvelope(job, encrypter, 'bucket', async () => {
            throw new Error('should not need S3');
        });
        expect(new Set(Object.keys(env))).toEqual(new Set(['v', 'id', 'ciphertext']));
        const asText = JSON.stringify(env);
        for (const secret of ['193.237.192.25', 'Amazon CloudFront', 'GitHub projects']) {
            expect(asText).not.toContain(secret);
        }
    });

    /**
     * Oversized payloads take the claim-check path — and it is the
     * *ciphertext* that goes to S3. Putting plaintext there would defeat the
     * age layer entirely: an object store is no more trusted than a queue.
     */
    it('spills ciphertext, never plaintext, to S3 when too large', async () => {
        const marker = 'SECRET-MESSAGE-';
        const job = toJob(item({ S: undefined, userMessage: { S: marker + 'y'.repeat(400_000) } }));
        let storedKey = '';
        let storedBody = new Uint8Array();
        const env = await buildEnvelope(job, encrypter, 'payloads', async (key, body) => {
            storedKey = key;
            storedBody = body;
        });

        expect(env.ciphertext).toBeUndefined();
        expect(env.s3).toEqual({ bucket: 'payloads', key: `cvchat/${job.id}.age` });
        expect(storedKey.startsWith('cvchat/')).toBe(true);

        // What went to S3 is the encrypter's output, not the plaintext.
        const stored = Buffer.from(storedBody).toString('latin1');
        expect(stored).not.toContain(marker);
        expect(stored).toBe(
            Buffer.from(await encrypter.encrypt(new TextEncoder().encode(JSON.stringify(job)))).toString('latin1'),
        );
    });
});
