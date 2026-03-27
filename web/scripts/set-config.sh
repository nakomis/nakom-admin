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

if [ "${1:-}" = "localhost" ]; then
    BASE_URL="http://localhost:5173"
else
    BASE_URL="https://admin.nakom.is"
fi

UP=$(get AdminCognitoStack UserPoolId)
CLIENT=$(get AdminCognitoStack UserPoolClientId)
IP=$(get AdminCognitoStack IdentityPoolId)
API=$(get AdminApiStack ApiCustomDomainUrl)

setValue userPoolId "$UP"
setValue authority "https://cognito-idp.${REGION}.amazonaws.com/${UP}"
setValue userPoolClientId "$CLIENT"
setValue identityPoolId "$IP"
setValue redirectUri "${BASE_URL}/loggedin"
setValue logoutUri "${BASE_URL}/logout"
setValue apiEndpoint "$API"

rm -f "${CONFIG}.bk"
echo "Config updated: $CONFIG (base URL: $BASE_URL)"
