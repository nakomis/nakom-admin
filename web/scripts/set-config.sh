#!/bin/bash
set -euo pipefail
PROFILE="${AWS_PROFILE:-nakom.is-admin}"
REGION="eu-west-2"
CONFIG="$(dirname "$0")/../src/config/config.json"

get() {
    aws cloudformation describe-stacks --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
        --output text --region "$REGION" --profile "$PROFILE"
}

setValue() {
    local key="$1"
    local value="$2"
    echo "Setting $key to $value"
    sed -i.bk "s|\"$key\": \".*\"|\"$key\": \"$value\"|g" "$CONFIG"
}

UP=$(get AdminCognitoStack UserPoolId)
CLIENT=$(get AdminCognitoStack UserPoolClientId)
IP=$(get AdminCognitoStack IdentityPoolId)

setValue userPoolId "$UP"
setValue authority "https://cognito-idp.${REGION}.amazonaws.com/${UP}"
setValue userPoolClientId "$CLIENT"
setValue identityPoolId "$IP"

rm -f "${CONFIG}.bk"
echo "Config updated: $CONFIG"
