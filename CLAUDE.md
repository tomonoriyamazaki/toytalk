# CLAUDE.md

## ワークフロールール

- 「コミットして」と言われたらコミットだけ行う。PR作成・マージ・ブランチクリーンアップは明示的な指示があるまでやらない。
- Lambda関数を修正したら、コミット前にデプロイする。各Lambda配下の `deploy.sh` を実行（例: `cd backend/<lambda-dir> && bash deploy.sh`）。
