#!/bin/sh
# The weekly proposal on your own machine or a VM, instead of GitHub Actions.
# crontab: 0 7 * * 1  cd /path/to/app-repo && sh weekly.sh >> .appeeky/weekly.log 2>&1
# Needs: git with push access, gh (logged in), node 20+, claude (logged in, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`), and the same env as CI.
set -e
git switch main && git pull --ff-only
npx -y @appeeky/spec data pull || true
npx -y @appeeky/spec reviews pull || true
npx -y @appeeky/spec competitors pull || true
free=$(npx -y @appeeky/spec status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).free.join(" ")))')
[ -n "$free" ] || { echo "Every store has a release being measured."; exit 0; }
rm -f .appeeky/proposal.md
claude -p "$(cat .github/appeeky-propose.md)

Stores free to change: $free" --allowedTools "Read" "Edit" "Write" "Bash(npx @appeeky/spec *)"
if git diff --quiet -- appeeky/store appeeky.spec.yaml || [ ! -f .appeeky/proposal.md ]; then echo "Nothing proposed."; exit 0; fi
branch="listing/weekly-$(date +%F)"
git switch -c "$branch"
git add appeeky/store appeeky.spec.yaml
git commit -m "$(head -1 .appeeky/proposal.md)"
git push origin "$branch"
gh pr create --title "$(head -1 .appeeky/proposal.md)" --body-file .appeeky/proposal.md
git switch main
