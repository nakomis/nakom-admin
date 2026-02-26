import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class CertificateStack extends cdk.Stack {
    readonly certificate: acm.Certificate;

    constructor(scope: Construct, id: string, props: cdk.StackProps) {
        super(scope, id, props);

        // Look up the existing nakom.is hosted zone (managed in nakom.is project)
        const zone = route53.HostedZone.fromLookup(this, 'NakomIsZone', {
            domainName: 'nakom.is',
        });

        this.certificate = new acm.Certificate(this, 'AdminCert', {
            domainName: 'admin.nakom.is',
            validation: acm.CertificateValidation.fromDns(zone),
        });
    }
}
