#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CertificateStack } from '../lib/certificate-stack';
import { CognitoStack } from '../lib/cognito-stack';
import { AnalyticsStack } from '../lib/analytics-stack';
import { CloudfrontStack } from '../lib/cloudfront-stack';
import { ApiStack } from '../lib/api-stack';

const app = new cdk.App();
const londonEnv = { env: { account: '637423226886', region: 'eu-west-2' } };
const nvirginiaEnv = { env: { account: '637423226886', region: 'us-east-1' } };

// Deploy order: AdminCertStack → AdminCognitoStack → AdminCloudfrontStack → AdminAnalyticsStack → AdminApiStack

const certStack = new CertificateStack(app, 'AdminCertStack', {
    ...nvirginiaEnv,
    crossRegionReferences: true,
});

const cognitoStack = new CognitoStack(app, 'AdminCognitoStack', londonEnv);

const analyticsStack = new AnalyticsStack(app, 'AdminAnalyticsStack', londonEnv);

const cloudfrontStack = new CloudfrontStack(app, 'AdminCloudfrontStack', {
    ...londonEnv,
    crossRegionReferences: true,
    certificate: certStack.certificate,
});

new ApiStack(app, 'AdminApiStack', {
    ...londonEnv,
    cognitoStack,
    analyticsStack,
});

cdk.Tags.of(app).add('MH-Project', 'nakom-admin');
