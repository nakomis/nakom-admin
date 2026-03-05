#!/bin/bash
set -euo pipefail
PROFILE="${AWS_PROFILE:-nakom.is-admin}"
REGION="eu-west-2"
BUCKET="nakomis-admin-web"
DIST_ID=$(aws cloudformation describe-stacks --stack-name AdminCloudfrontStack \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
    --output text --profile "$PROFILE" --region "$REGION")

bash "$(dirname "$0")/set-config.sh"
npm run build
aws s3 sync dist/ "s3://$BUCKET/" --delete --profile "$PROFILE" --region "$REGION"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
    --profile "$PROFILE" --region "$REGION"
echo "Deployed."
