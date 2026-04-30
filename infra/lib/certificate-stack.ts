import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { DeployEnv, getEnvConfig } from './env-config';

export interface CertificateStackProps extends cdk.StackProps {
    deployEnv: DeployEnv;
}

export class CertificateStack extends cdk.Stack {
    readonly certificate: acm.Certificate;

    constructor(scope: Construct, id: string, props: CertificateStackProps) {
        super(scope, id, props);

        const config = getEnvConfig(props.deployEnv);

        const zone = route53.HostedZone.fromLookup(this, 'Zone', {
            domainName: config.zoneName,
        });

        this.certificate = new acm.Certificate(this, 'AdminCert', {
            domainName: config.domainName,
            validation: acm.CertificateValidation.fromDns(zone),
        });
    }
}
