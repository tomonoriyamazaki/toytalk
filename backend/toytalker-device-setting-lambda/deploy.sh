#!/bin/bash
cd "$(dirname "$0")"

echo "📦 Installing dependencies..."
"/c/Program Files/nodejs/npm.cmd" install

echo "📦 Bundling with esbuild..."
"/c/Program Files/nodejs/npx.cmd" esbuild index.mjs --bundle --platform=node --format=cjs --outfile=bundle.js

echo "📁 Creating zip..."
mkdir -p temp_deploy
cp bundle.js temp_deploy/index.js
cd temp_deploy
powershell -Command "Compress-Archive -Path 'index.js' -DestinationPath '../deploy.zip' -Force"
cd ..
rm -rf temp_deploy

echo "🚀 Deploying to Lambda..."
aws lambda update-function-code \
  --function-name toytalker-device-setting-lambda \
  --zip-file fileb://deploy.zip \
  --region ap-northeast-1 \
  --query '[CodeSize, LastModified]' \
  --output text

echo "✅ Done!"
