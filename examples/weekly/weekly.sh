#!/bin/sh
# The weekly co-founder review on your own machine or a VM, instead of GitHub Actions.
# crontab: 0 7 * * 1  cd /path/to/app-repo && sh weekly.sh >> .appeeky/weekly.log 2>&1
# Needs: git with push access, gh (logged in), node 20+, claude (logged in, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`), and the same env as CI.
set -e
git switch main && git pull --ff-only
npx -y @appeeky/spec data pull || true
npx -y @appeeky/spec reviews pull || true
npx -y @appeeky/spec competitors pull || true
npx -y @appeeky/spec social pull || true
npx -y @appeeky/spec ugc pull || true
free=$(npx -y @appeeky/spec status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).free.join(" ")))')
prompt=.github/appeeky-propose.md
[ -f "$prompt" ] || prompt=.claude/commands/appeeky-cofounder.md
rm -f .appeeky/proposal.md
claude -p "Today is $(date +%F). Stores free to change: ${free:-none (write the brief only)}.

$(cat "$prompt")" < /dev/null \
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Task" "Agent" "Bash(appeeky-spec *)" "Bash(npx @appeeky/spec *)" "Bash(npx -y @appeeky/spec *)" "Bash(git log *)" "Bash(git tag *)" \
  --disallowedTools "Bash(appeeky-spec push*)" "Bash(appeeky-spec social push*)" "Bash(appeeky-spec reviews push*)" "Bash(appeeky-spec ugc generate --yes*)" "Bash(appeeky-spec ugc generate --local --yes*)" "Bash(appeeky-spec visibility scan --local --yes*)" "Bash(appeeky-spec seo ranks*--yes*)" "Bash(appeeky-spec seo keywords*--yes*)" "Bash(appeeky-spec seo domain*--yes*)" "Bash(appeeky-spec revert*)" "Bash(npx @appeeky/spec push*)" "Bash(npx @appeeky/spec social push*)" "Bash(npx @appeeky/spec reviews push*)" "Bash(npx @appeeky/spec ugc generate --yes*)" "Bash(npx @appeeky/spec ugc generate --local --yes*)" "Bash(npx @appeeky/spec visibility scan --local --yes*)" "Bash(npx @appeeky/spec seo ranks*--yes*)" "Bash(npx @appeeky/spec seo keywords*--yes*)" "Bash(npx @appeeky/spec seo domain*--yes*)" "Bash(npx @appeeky/spec revert*)" "Bash(npx -y @appeeky/spec push*)" "Bash(npx -y @appeeky/spec social push*)" "Bash(npx -y @appeeky/spec reviews push*)" "Bash(npx -y @appeeky/spec ugc generate --yes*)" "Bash(npx -y @appeeky/spec ugc generate --local --yes*)" "Bash(npx -y @appeeky/spec visibility scan --local --yes*)" "Bash(npx -y @appeeky/spec seo ranks*--yes*)" "Bash(npx -y @appeeky/spec seo keywords*--yes*)" "Bash(npx -y @appeeky/spec seo domain*--yes*)" "Bash(npx -y @appeeky/spec revert*)"
if [ ! -f .appeeky/proposal.md ] || [ -z "$(git status --porcelain -- appeeky/store appeeky.spec.yaml appeeky/briefs appeeky/social/drafts appeeky/ugc/briefs)" ]; then echo "Nothing proposed."; exit 0; fi
branch="listing/weekly-$(date +%F)"
git switch -c "$branch"
git add appeeky/store appeeky.spec.yaml appeeky/briefs appeeky/social/drafts appeeky/ugc/briefs
git commit -m "$(head -1 .appeeky/proposal.md)"
git push origin "$branch"
gh pr create --title "$(head -1 .appeeky/proposal.md)" --body-file .appeeky/proposal.md
git switch main
