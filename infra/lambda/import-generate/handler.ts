import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});
const bedrock = new BedrockRuntimeClient({ region: 'eu-west-2' });
const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});

const LOG_TYPE = 'CVCHAT';
const EMBED_MODEL = 'amazon.titan-embed-text-v2:0';

async function embedText(text: string): Promise<number[]> {
    const response = await bedrock.send(new InvokeModelCommand({
        modelId: EMBED_MODEL,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text.slice(0, 8000) }), // Titan v2 max 8192 tokens
    }));
    const result = JSON.parse(Buffer.from(response.body).toString());
    return result.embedding as number[];
}

export const handler = async () => {
    const stagingBucket = process.env.STAGING_BUCKET!;
    const executeFunctionName = process.env.IMPORT_EXECUTE_FUNCTION_NAME!;
    const cursorParam = process.env.IMPORT_CURSOR_PARAM!;

    // Read cursor
    const cursorResult = await ssm.send(new GetParameterCommand({ Name: cursorParam }));
    const cursor = cursorResult.Parameter!.Value!;

    // Query unimported records
    const queryResult = await ddb.send(new QueryCommand({
        TableName: 'nakomis-chat-logs',
        KeyConditionExpression: 'logType = :lt AND sk > :cursor',
        ExpressionAttributeValues: {
            ':lt': { S: LOG_TYPE },
            ':cursor': { S: cursor },
        },
        // Skip SMS_SENT sentinel records (they share the same PK)
        FilterExpression: 'attribute_exists(userMessage)',
    }));

    const items = queryResult.Items ?? [];
    if (items.length === 0) return { imported: 0 };

    // Generate embeddings and build record batch
    const records = [];
    let newCursor = cursor;

    for (const item of items) {
        const userMessage = item.userMessage?.S ?? '';
        const embedding = await embedText(userMessage);

        records.push({
            id: item.sk.S!,
            logType: item.logType.S!,
            conversationId: item.conversationId?.S ?? null,
            ip: item.ip?.S ?? null,
            userAgent: item.userAgent?.S ?? null,
            country: item.country?.S ?? null,
            userMessage,
            messageCount: parseInt(item.messageCount?.N ?? '0'),
            toolsCalled: item.toolsCalled?.SS ?? [],
            inputTokens: parseInt(item.inputTokens?.N ?? '0'),
            outputTokens: parseInt(item.outputTokens?.N ?? '0'),
            durationMs: parseInt(item.durationMs?.N ?? '0'),
            rateLimited: item.rateLimited?.BOOL ?? false,
            embedding,
        });

        if (item.sk.S! > newCursor) newCursor = item.sk.S!;
    }

    // Write to S3 staging
    const stagingKey = `import-staging/${Date.now()}.json`;
    await s3.send(new PutObjectCommand({
        Bucket: stagingBucket,
        Key: stagingKey,
        Body: JSON.stringify(records),
        ContentType: 'application/json',
    }));

    // Advance cursor before async invocation — import-execute is idempotent (ON CONFLICT DO NOTHING)
    await ssm.send(new PutParameterCommand({
        Name: cursorParam,
        Value: newCursor,
        Type: 'String',
        Overwrite: true,
    }));

    // Invoke import-execute Lambda async
    await lambdaClient.send(new InvokeCommand({
        FunctionName: executeFunctionName,
        InvocationType: 'Event',
        Payload: JSON.stringify({ stagingBucket, stagingKey }),
    }));

    return { queued: records.length, stagingKey };
};
