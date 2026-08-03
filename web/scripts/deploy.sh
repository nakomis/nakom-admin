#!/bin/bash
#
# Manual web deploy (ADMIN-3).
#
# Chooses its target from NPM_ENVIRONMENT, the same variable the CDK app reads,
# so the SPA and the infrastructure it talks to cannot be pointed at different
# environments by accident.
set -euo pipefail

# Defaults to prod because that is what this script did unconditionally before
# it knew about environments: an existing `./deploy.sh` in someone's shell
# history keeps doing exactly what it used to.
DEPLOY_ENV="${NPM_ENVIRONMENT:-prod}"

# Account ids and bucket names are duplicated from infra/lib/env-config.ts,
# which remains the source of truth — bash cannot import it. The caller-identity
# check below is what makes a drift here loud rather than silent, so this copy
# cannot quietly send a build to the wrong account.
case "$DEPLOY_ENV" in
    prod)
        DEFAULT_PROFILE="nakom.is-admin"
        BUCKET="nakomis-admin-web"
        EXPECT_ACCOUNT="637423226886"
        ;;
    sandbox)
        DEFAULT_PROFILE="nakom.is-sandbox"
        BUCKET="nakomis-admin-sandbox-web"
        EXPECT_ACCOUNT="975050268859"
        ;;
    *)
        echo "Unknown NPM_ENVIRONMENT \"$DEPLOY_ENV\". Must be \"sandbox\" or \"prod\"." >&2
        exit 1
        ;;
esac

PROFILE="${AWS_PROFILE:-$DEFAULT_PROFILE}"
REGION="eu-west-2"

# AWS_PROFILE is honoured, but it is exactly the way a sandbox deploy ends up in
# prod: a profile left exported from an earlier command silently wins over
# NPM_ENVIRONMENT. Verify the credentials actually belong to the environment
# being deployed, and stop before anything is written if they do not.
ACTUAL_ACCOUNT=$(aws sts get-caller-identity --query Account --output text \
    --profile "$PROFILE" --region "$REGION")
if [ "$ACTUAL_ACCOUNT" != "$EXPECT_ACCOUNT" ]; then
    echo "Refusing to deploy: NPM_ENVIRONMENT=$DEPLOY_ENV expects account $EXPECT_ACCOUNT," >&2
    echo "but profile \"$PROFILE\" is account $ACTUAL_ACCOUNT." >&2
    exit 1
fi

# Exported so set-config.sh reads SSM from this same account. It takes no
# profile argument and relies on ambient credentials, so without this it would
# happily build a config from whatever profile the shell defaulted to and hand
# it to a deploy pointed somewhere else.
export AWS_PROFILE="$PROFILE"

DIST_ID=$(aws cloudformation describe-stacks --stack-name AdminCloudfrontStack \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
    --output text --profile "$PROFILE" --region "$REGION")

echo "Deploying to $DEPLOY_ENV (account $ACTUAL_ACCOUNT, bucket $BUCKET)"

bash "$(dirname "$0")/set-config.sh"
pnpm run build
aws s3 sync dist/ "s3://$BUCKET/" --delete --profile "$PROFILE" --region "$REGION"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
    --profile "$PROFILE" --region "$REGION"
echo "Deployed to $DEPLOY_ENV."
