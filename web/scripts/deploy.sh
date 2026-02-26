#!/bin/bash
set -euo pipefail
PROFILE="${AWS_PROFILE:-nakom.is-admin}"
BUCKET="nakomis-admin-web"
DIST_ID=$(aws cloudformation describe-stacks --stack-name AdminCloudfrontStack \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
    --output text --profile "$PROFILE")

npm run build
aws s3 sync dist/ "s3://$BUCKET/" --delete --profile "$PROFILE"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
    --profile "$PROFILE"
echo "Deployed."
