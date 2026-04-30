#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import { CertificateStack } from '../lib/certificate-stack';
import { CognitoStack } from '../lib/cognito-stack';
import { AnalyticsStack } from '../lib/analytics-stack';
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
const nvirginiaEnv = { env: { account: config.account, region: 'us-east-1' } };
const githubOidcProviderArn = `arn:aws:iam::${config.account}:oidc-provider/token.actions.githubusercontent.com`;

const app = new cdk.App();

// Deploy order: AdminCertStack → AdminCognitoStack → AdminAnalyticsStack → AdminApiStack → AdminCloudfrontStack → AdminGithubCiStack

const certStack = new CertificateStack(app, 'AdminCertStack', {
    ...nvirginiaEnv,
    deployEnv,
    crossRegionReferences: true,
});

const cognitoStack = new CognitoStack(app, 'AdminCognitoStack', {
    ...londonEnv,
    deployEnv,
});

const analyticsStack = new AnalyticsStack(app, 'AdminAnalyticsStack', {
    ...londonEnv,
    deployEnv,
});

const apiStack = new ApiStack(app, 'AdminApiStack', {
    ...londonEnv,
    deployEnv,
    cognitoStack,
    analyticsStack,
});

const cloudfrontStack = new CloudfrontStack(app, 'AdminCloudfrontStack', {
    ...londonEnv,
    deployEnv,
    crossRegionReferences: true,
    certificate: certStack.certificate,
    apiOriginDomain: apiStack.api.apiEndpoint,
});

new GithubCiStack(app, 'AdminGithubCiStack', {
    ...londonEnv,
    deployEnv,
    githubOidcProviderArn,
    webBucket: cloudfrontStack.webBucket,
    webDistribution: cloudfrontStack.distribution,
});

const { version: infraVersion } = JSON.parse(fs.readFileSync('./version.json', 'utf-8'));
cdk.Tags.of(app).add('MH-Project', 'nakom-admin');
cdk.Tags.of(app).add('MH-Version', infraVersion);
