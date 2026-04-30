#!/usr/bin/env bash
# Reads SSM params (written by CDK stacks) and writes src/config/config.json.
# Assumes AWS credentials are already configured for the correct account.
set -euo pipefail

CONFIG="$(dirname "$0")/../src/config/config.json"
mkdir -p "$(dirname "$CONFIG")"

get() {
    aws ssm get-parameter --name "/nakom-admin/$1" --query Parameter.Value --output text
}

LOGIN_DOMAIN=$(get cognito/login-domain)
APP_DOMAIN=$(get app-domain)
USER_POOL_ID=$(get cognito/user-pool-id)
REGION="eu-west-2"

cat > "$CONFIG" <<JSON
{
  "aws": { "region": "$REGION" },
  "cognito": {
    "authority":        "https://cognito-idp.$REGION.amazonaws.com/$USER_POOL_ID",
    "userPoolId":       "$USER_POOL_ID",
    "userPoolClientId": "$(get cognito/client-id)",
    "cognitoDomain":    "$LOGIN_DOMAIN",
    "redirectUri":      "https://$APP_DOMAIN/loggedin",
    "logoutUri":        "https://$APP_DOMAIN/logout",
    "identityPoolId":   "$(get cognito/identity-pool-id)"
  },
  "apiEndpoint": "$(get api-endpoint)"
}
JSON

echo "Config written: $CONFIG"
