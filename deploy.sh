#!/usr/bin/env bash
# Reproducible deploy: DynamoDB + SSM + IAM + Lambda (Function URL) + S3 + CloudFront + PayPal webhook.
# Plain aws CLI. Safe to re-run. Needs: aws (authenticated), node 20+, zip, curl. Reads ../../.env for PayPal sandbox creds.
set -euo pipefail
cd "$(dirname "$0")"
ACCOUNT=854924711083; REGION=us-east-1
export AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "wrong AWS account"; exit 1; }
set -a; . ../../.env; set +a
TABLE=escrow-ledger; FN=escrow-api; ROLE=escrow-lambda-role; BUCKET=escrow-web-$ACCOUNT; SSM=/escrow
step() { printf '\n== %s\n' "$*"; }

step "DynamoDB table (on-demand)"
aws dynamodb describe-table --table-name $TABLE >/dev/null 2>&1 || {
  aws dynamodb create-table --table-name $TABLE --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE >/dev/null
  aws dynamodb wait table-exists --table-name $TABLE
  aws dynamodb update-time-to-live --table-name $TABLE --time-to-live-specification Enabled=true,AttributeName=expires >/dev/null
}

step "SSM parameters (PayPal secret is a SecureString, never in the Lambda env or the repo)"
put() { aws ssm put-parameter --name "$SSM/$1" --value "$2" --type "${3:-String}" --overwrite >/dev/null; }
put PAYPAL_CLIENT_ID "$PAYPAL_CLIENT_ID"; put PAYPAL_SECRET "$PAYPAL_SECRET" SecureString; put PAYPAL_API "$PAYPAL_API"
[ -f .recipients.json ] && put RECIPIENTS_JSON "$(cat .recipients.json)" || echo "   (no .recipients.json: payees use placeholder addresses, so payouts end UNCLAIMED)"

step "IAM role"
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 8
fi
aws iam put-role-policy --role-name $ROLE --policy-name escrow-access --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
 {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",\"dynamodb:DeleteItem\",\"dynamodb:Query\",\"dynamodb:BatchWriteItem\"],\"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\"},
 {\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParametersByPath\",\"ssm:GetParameter\"],\"Resource\":\"arn:aws:ssm:$REGION:$ACCOUNT:parameter$SSM*\"},
 {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:InvokeModelWithResponseStream\"],\"Resource\":\"*\"}]}"
ROLE_ARN=arn:aws:iam::$ACCOUNT:role/$ROLE

step "Package Lambda (Node 22; AWS SDK v3 ships in the runtime, so no dependencies are bundled)"
node -e "require('fs').rmSync('.build',{recursive:true,force:true})"; mkdir -p .build && cp backend/src/*.mjs backend/src/*.json .build/ 2>/dev/null || cp backend/src/*.mjs .build/
node -e "require('fs').rmSync('.build/local.mjs',{force:true})"; (cd .build && zip -qr ../function.zip .)
ENVV="Variables={TABLE=$TABLE,SSM_PREFIX=$SSM/,BEDROCK_MODEL=$BEDROCK_MODEL}"
if aws lambda get-function --function-name $FN >/dev/null 2>&1; then
  aws lambda update-function-code --function-name $FN --zip-file fileb://function.zip >/dev/null
  aws lambda wait function-updated --function-name $FN
  aws lambda update-function-configuration --function-name $FN --timeout 150 --memory-size 512 --environment "$ENVV" >/dev/null
else
  aws lambda create-function --function-name $FN --runtime nodejs22.x --handler handler.handler --role $ROLE_ARN \
    --zip-file fileb://function.zip --timeout 150 --memory-size 512 --environment "$ENVV" >/dev/null
fi
aws lambda wait function-updated --function-name $FN

step "Function URL (public, CORS open; the app holds only sandbox money)"
aws lambda get-function-url-config --function-name $FN >/dev/null 2>&1 || {
  aws lambda create-function-url-config --function-name $FN --auth-type NONE \
    --cors '{"AllowOrigins":["*"],"AllowMethods":["*"],"AllowHeaders":["content-type"],"MaxAge":3600}' >/dev/null
  aws lambda add-permission --function-name $FN --statement-id url-public --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true
}
node scripts/allow-url-invoke.mjs $FN
API_URL=$(aws lambda get-function-url-config --function-name $FN --query FunctionUrl --output text); API_URL=${API_URL%/}
echo "   $API_URL"

step "PayPal webhook (payout batch, payout item and invoice events)"
WH_ID=$(aws ssm get-parameter --name $SSM/PAYPAL_WEBHOOK_ID --query Parameter.Value --output text 2>/dev/null || true)
TOK=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_SECRET" -d grant_type=client_credentials $PAYPAL_API/v1/oauth2/token | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
if [ -z "$WH_ID" ] || [ "$WH_ID" = None ]; then
  RES=$(curl -s -X POST $PAYPAL_API/v1/notifications/webhooks -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"url\":\"$API_URL/api/webhook\",\"event_types\":[
   {\"name\":\"PAYMENT.PAYOUTSBATCH.PROCESSING\"},{\"name\":\"PAYMENT.PAYOUTSBATCH.SUCCESS\"},{\"name\":\"PAYMENT.PAYOUTSBATCH.DENIED\"},
   {\"name\":\"PAYMENT.PAYOUTS-ITEM.SUCCEEDED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.UNCLAIMED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.FAILED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.BLOCKED\"},
   {\"name\":\"PAYMENT.PAYOUTS-ITEM.HELD\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.RETURNED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.REFUNDED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.CANCELED\"},
   {\"name\":\"INVOICING.INVOICE.PAID\"}]}")
  WH_ID=$(echo "$RES" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id || ""')
  [ -n "$WH_ID" ] || { echo "webhook creation failed: $RES"; exit 1; }
  put PAYPAL_WEBHOOK_ID "$WH_ID"
  aws lambda update-function-configuration --function-name $FN --environment "Variables={TABLE=$TABLE,SSM_PREFIX=$SSM/,BEDROCK_MODEL=$BEDROCK_MODEL,CFG_REV=$(date +%s)}" >/dev/null
  aws lambda wait function-updated --function-name $FN
fi
echo "   webhook id $WH_ID"

step "Frontend build, S3 and CloudFront"
(cd frontend && npm ci --silent 2>/dev/null || npm i --silent; VITE_API_URL=$API_URL npx vite build >/dev/null)
aws s3api head-bucket --bucket $BUCKET 2>/dev/null || {
  aws s3api create-bucket --bucket $BUCKET >/dev/null
  aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
}
aws s3 sync frontend/dist s3://$BUCKET --delete --cache-control 'no-cache' --exclude 'assets/*' >/dev/null
aws s3 sync frontend/dist/assets s3://$BUCKET/assets --cache-control 'public,max-age=31536000,immutable' >/dev/null
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='escrow-web'].Id | [0]" --output text 2>/dev/null || true)
if [ -z "$DIST" ] || [ "$DIST" = None ]; then
  OAC=$(aws cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='escrow-oac'].Id | [0]" --output text)
  if [ -z "$OAC" ] || [ "$OAC" = None ]; then OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config "Name=escrow-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" --query OriginAccessControl.Id --output text); fi
  CACHE=$(aws cloudfront list-cache-policies --type managed --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='Managed-CachingOptimized'].CachePolicy.Id | [0]" --output text)
  cat > .cf.json <<JSON
{"CallerReference":"escrow-$(date +%s)","Comment":"escrow-web","Enabled":true,"DefaultRootObject":"index.html","PriceClass":"PriceClass_100","HttpVersion":"http2and3",
 "Origins":{"Quantity":1,"Items":[{"Id":"s3","DomainName":"$BUCKET.s3.$REGION.amazonaws.com","OriginAccessControlId":"$OAC","S3OriginConfig":{"OriginAccessIdentity":""}}]},
 "DefaultCacheBehavior":{"TargetOriginId":"s3","ViewerProtocolPolicy":"redirect-to-https","Compress":true,"CachePolicyId":"$CACHE","AllowedMethods":{"Quantity":2,"Items":["GET","HEAD"]}},
 "CustomErrorResponses":{"Quantity":2,"Items":[{"ErrorCode":403,"ResponsePagePath":"/index.html","ResponseCode":"200","ErrorCachingMinTTL":0},{"ErrorCode":404,"ResponsePagePath":"/index.html","ResponseCode":"200","ErrorCachingMinTTL":0}]}}
JSON
  DIST=$(aws cloudfront create-distribution --distribution-config file://.cf.json --query Distribution.Id --output text); rm -f .cf.json
fi
DARN=arn:aws:cloudfront::$ACCOUNT:distribution/$DIST
aws s3api put-bucket-policy --bucket $BUCKET --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"cf\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"$DARN\"}}}]}"
aws cloudfront create-invalidation --distribution-id $DIST --paths '/*' >/dev/null
CF=$(aws cloudfront get-distribution --id $DIST --query Distribution.DomainName --output text)
printf '{"functionUrl":"%s","cloudfront":"https://%s","distribution":"%s","bucket":"%s","webhookId":"%s"}\n' "$API_URL" "$CF" "$DIST" "$BUCKET" "$WH_ID" > .deploy-state.json
step "Done"; cat .deploy-state.json
