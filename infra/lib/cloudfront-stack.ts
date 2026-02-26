import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface CloudfrontStackProps extends cdk.StackProps {
    certificate: acm.Certificate;
    apiOriginDomain?: string; // set after ApiStack deploys
}

export class CloudfrontStack extends cdk.Stack {
    readonly distribution: cloudfront.Distribution;
    readonly webBucket: s3.Bucket;

    constructor(scope: Construct, id: string, props: CloudfrontStackProps) {
        super(scope, id, props);

        this.webBucket = new s3.Bucket(this, 'WebBucket', {
            bucketName: 'nakomis-admin-web',
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.distribution = new cloudfront.Distribution(this, 'AdminDistribution', {
            comment: 'nakom-admin',
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            },
            defaultRootObject: 'index.html',
            errorResponses: [{
                // SPA routing — serve index.html for 403/404 so React Router works
                httpStatus: 403,
                responseHttpStatus: 200,
                responsePagePath: '/index.html',
            }, {
                httpStatus: 404,
                responseHttpStatus: 200,
                responsePagePath: '/index.html',
            }],
            domainNames: ['admin.nakom.is'],
            certificate: props.certificate,
        });

        // Add admin.nakom.is A record to the existing nakom.is hosted zone
        const zone = route53.HostedZone.fromLookup(this, 'NakomIsZone', {
            domainName: 'nakom.is',
        });
        new route53.ARecord(this, 'AdminARecord', {
            zone,
            recordName: 'admin',
            target: route53.RecordTarget.fromAlias(
                new targets.CloudFrontTarget(this.distribution),
            ),
        });

        new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    }
}
