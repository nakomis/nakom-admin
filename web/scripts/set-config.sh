#!/bin/bash
set -euo pipefail
PROFILE="${AWS_PROFILE:-nakom.is-admin}"
REGION="eu-west-2"

get() {
    aws cloudformation describe-stacks --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
        --output text --region "$REGION" --profile "$PROFILE"
}

UP=$(get AdminCognitoStack UserPoolId)
CLIENT=$(get AdminCognitoStack UserPoolClientId)
IP=$(get AdminCognitoStack IdentityPoolId)
API=$(get AdminApiStack ApiEndpoint)

sed "s|__USER_POOL_ID__|$UP|g; s|__CLIENT_ID__|$CLIENT|g; \
     s|__IDENTITY_POOL_ID__|$IP|g; s|https://__API_ID__.execute-api.eu-west-2.amazonaws.com|$API|g" \
    src/config/config.json.template > src/config/config.json

echo "Config written to src/config/config.json"
