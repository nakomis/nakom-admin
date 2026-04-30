import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { DeployEnv, getEnvConfig } from './env-config';

export interface CloudfrontStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
    certificate: acm.Certificate;
    apiOriginDomain?: string; // set after ApiStack deploys
}

export class CloudfrontStack extends cdk.Stack {
    readonly distribution: cloudfront.Distribution;
    readonly webBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: CloudfrontStackProps) {
        super(scope, id, props);

        const config = getEnvConfig(props.deployEnv);

        // Creates the bucket on first deploy; silently adopts it if it already exists.
        // This documents the intended configuration even when the bucket pre-dates the stack.
        const bucketName = config.webBucketName;
        const ensureBucket = new cr.AwsCustomResource(this, 'EnsureWebBucket', {
            installLatestAwsSdk: false,
            onCreate: {
                service: 'S3',
                action: 'createBucket',
                parameters: {
                    Bucket: bucketName,
                    CreateBucketConfiguration: { LocationConstraint: this.region },
                },
                ignoreErrorCodesMatching: 'BucketAlreadyOwnedByYou|BucketAlreadyExists',
                physicalResourceId: cr.PhysicalResourceId.of(bucketName),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
                resources: [`arn:aws:s3:::${bucketName}`],
            }),
        });
        this.webBucket = s3.Bucket.fromBucketName(this, 'WebBucket', bucketName);

        // Rewrite SPA routes (no file extension) to /index.html at the viewer,
        // so S3 never returns a 403 for missing routes and API error responses are unaffected.
        const spaRoutingFn = new cloudfront.Function(this, 'SpaRoutingFn', {
            code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
    var uri = event.request.uri;
    if (!uri.includes('.')) {
        event.request.uri = '/index.html';
    }
    return event.request;
}
`),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
        });

        // Strip the /api prefix before forwarding to API Gateway.
        // CloudFront matches /api/rds/status but the Gateway routes are /rds/status,
        // so without this the origin receives /prod/api/rds/status → 404.
        const apiPrefixFn = new cloudfront.Function(this, 'ApiPrefixFn', {
            code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
    event.request.uri = event.request.uri.replace(/^\\/api/, '');
    return event.request;
}
`),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
        });

        // Create additional behaviors for API if provided
        const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};

        if (props.apiOriginDomain) {
            // apiOriginDomain is a CDK Token at synth time — .replace() won't work.
            // Use Fn.select/split to strip the https:// prefix at the CloudFormation level.
            const apiHost = cdk.Fn.select(1, cdk.Fn.split('https://', props.apiOriginDomain));
            additionalBehaviors['/api/*'] = {
                origin: new origins.HttpOrigin(apiHost, {
                    originId: 'AdminApiOrigin',
                    originPath: '/prod',
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                functionAssociations: [{
                    function: apiPrefixFn,
                    eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                }],
            };
        }

        this.distribution = new cloudfront.Distribution(this, 'AdminDistribution', {
            comment: 'nakom-admin-with-spa-routing',
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                functionAssociations: [{
                    function: spaRoutingFn,
                    eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                }],
            },
            additionalBehaviors,
            defaultRootObject: 'index.html',
            // No global error responses - handled per behavior
            // API calls should return real errors, SPA routes need index.html
            domainNames: [config.domainName],
            certificate: props.certificate,
        });

        const zone = route53.HostedZone.fromLookup(this, 'Zone', {
            domainName: config.zoneName,
        });
        new route53.ARecord(this, 'AdminARecord', {
            zone,
            recordName: 'admin',
            target: route53.RecordTarget.fromAlias(
                new targets.CloudFrontTarget(this.distribution),
            ),
        });
        new route53.AaaaRecord(this, 'AdminAaaaRecord', {
            zone,
            recordName: 'admin',
            target: route53.RecordTarget.fromAlias(
                new targets.CloudFrontTarget(this.distribution),
            ),
        });

        new ssm.StringParameter(this, 'DistributionIdParam', {
            parameterName: '/nakom-admin/web/distribution-id',
            stringValue: this.distribution.distributionId,
        });
        new ssm.StringParameter(this, 'BucketNameParam', {
            parameterName: '/nakom-admin/web/bucket-name',
            stringValue: bucketName,
        });

        // withOriginAccessControl calls addToResourcePolicy internally, but imported buckets
        // (fromBucketName) have autoCreatePolicy=false so that call is silently ignored.
        // We create the BucketPolicy explicitly instead.
        const oacPolicy = new s3.CfnBucketPolicy(this, 'WebBucketOacPolicy', {
            bucket: bucketName,
            policyDocument: {
                Version: '2012-10-17',
                Statement: [{
                    Sid: 'AllowCloudFrontOac',
                    Effect: 'Allow',
                    Principal: { Service: 'cloudfront.amazonaws.com' },
                    Action: 's3:GetObject',
                    Resource: `arn:aws:s3:::${bucketName}/*`,
                    Condition: {
                        StringEquals: {
                            'AWS:SourceArn': this.distribution.distributionArn,
                        },
                    },
                }],
            },
        });
        oacPolicy.node.addDependency(ensureBucket);

        new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    }
}
