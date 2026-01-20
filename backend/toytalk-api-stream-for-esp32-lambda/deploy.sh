#!/bin/bash
# デプロイスクリプト - index.mjs を編集後にこれを実行

cd "$(dirname "$0")"

echo "📦 Bundling with esbuild..."
"/c/Program Files/nodejs/npx.cmd" esbuild index.mjs --bundle --platform=node --format=esm --outfile=bundle.mjs

echo "📁 Creating zip..."
mkdir -p temp_deploy
cp bundle.mjs temp_deploy/index.mjs
cd temp_deploy
powershell -Command "Compress-Archive -Path 'index.mjs' -DestinationPath '../deploy.zip' -Force"
cd ..
rm -rf temp_deploy

echo "🚀 Deploying to Lambda..."
aws lambda update-function-code \
  --function-name toytalk-api-stream-for-esp32-lambda \
  --zip-file fileb://deploy.zip \
  --region ap-northeast-1 \
  --query '[CodeSize, LastModified]' \
  --output text

echo "✅ Done!"
