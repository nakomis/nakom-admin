#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import { CognitoStack } from '../lib/cognito-stack';
import { CloudfrontStack } from '../lib/cloudfront-stack';
import { ApiStack } from '../lib/api-stack';
import { GithubCiStack } from '../lib/github-ci-stack';
import { getEnvConfig, DeployEnv } from '../lib/env-config';

const npmEnvironment = process.env.NPM_ENVIRONMENT;
if (!npmEnvironment) {
    throw new Error('NPM_ENVIRONMENT is not set. Use NPM_ENVIRONMENT=sandbox|prod.');
}
if (npmEnvironment !== 'sandbox' && npmEnvironment !== 'prod') {
    throw new Error(`Unknown NPM_ENVIRONMENT "${npmEnvironment}". Must be "sandbox" or "prod".`);
}

const deployEnv = npmEnvironment as DeployEnv;
const config = getEnvConfig(deployEnv);

const londonEnv = { env: { account: config.account, region: 'eu-west-2' } };
const githubOidcProviderArn = `arn:aws:iam::${config.account}:oidc-provider/token.actions.githubusercontent.com`;

const app = new cdk.App();

const cognitoStack = new CognitoStack(app, 'AdminCognitoStack', {
    ...londonEnv,
    deployEnv,
});

// AdminAnalyticsStack is gone (ADMIN-10): Aurora Serverless v2, its VPC, the
// isolated subnets, the security group and the S3 staging bucket. Everything
// it held is now on Luke's admin_analytics, reached through Cal.
//
// DELETING IT IS NOT AUTOMATIC. Removing the stack from this file stops CDK
// managing it; the CloudFormation stack and its resources stay until someone
// runs `cdk destroy AdminAnalyticsStack` (or deletes it in the console). Do
// that only after confirming the backfill has populated Luke — the cluster is
// the only remaining copy of the Titan-embedded rows, and while those vectors
// are not reusable (different model), the source records are also in DynamoDB
// and that is what the backfill reads.

const apiStack = new ApiStack(app, 'AdminApiStack', {
    ...londonEnv,
    deployEnv,
    cognitoStack,
});

const cloudfrontStack = new CloudfrontStack(app, 'AdminCloudfrontStack', {
    ...londonEnv,
    deployEnv,
    apiOriginDomain: apiStack.api.apiEndpoint,
});

new GithubCiStack(app, 'AdminGithubCiStack', {
    ...londonEnv,
    deployEnv,
    githubOidcProviderArn,
});

const { version: infraVersion } = JSON.parse(fs.readFileSync('./version.json', 'utf-8'));
cdk.Tags.of(app).add('MH-Project', 'nakom-admin');
cdk.Tags.of(app).add('MH-Version', infraVersion);
