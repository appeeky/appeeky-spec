#!/bin/sh
# Appeeky Spec routines outside GitHub Actions.
#
# Each routine clones the repo, does one thing, commits what it wrote and exits. All
# state lives in the repo, so the container keeps nothing between runs.
#
#   daily     category rank, AI visibility, verify, reviews, competitors (once a day)
#   push      push merged listing changes to the stores (every 10–15 minutes)
#   weekly    an agent proposes one listing change as a pull request (image built with AGENT=1)
#   schedule  stay up and run the routines above on a schedule (docker compose, Railway, Fly)
#
# Pick one with MODE=<routine> or as the first argument.
#
# Env:
#   REPO_URL          https://github.com/you/app.git (or any git URL)
#   GITHUB_TOKEN      token with contents write on that repo (weekly: pull requests write too)
#   APPEEKY_API_KEY   store access, analytics, AI visibility
#   BRANCH            default main
#   SPEC_DIR          folder with appeeky.spec.yaml inside the repo, default .
#   PUSH_DRY_RUN=1    push: show what would be pushed, change nothing
#   HEALTHCHECK_URL   daily: pinged when it succeeds, <url>/fail when it fails (healthchecks.io style)
#   schedule:         DAILY_AT (default "0 6 * * *"), PUSH_EVERY (default "*/15 * * * *", "off" to disable),
#                     WEEKLY_AT (default off, e.g. "0 7 * * 1"). Times are UTC.
#   weekly:           CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`: uses your Claude Pro or Max plan)
#                     or ANTHROPIC_API_KEY (billed per use)
#   ATTRIBUTION_TOKEN with a self-hosted attribution server
set -eu

MODE="${1:-${MODE:-}}"
: "${REPO_URL:?Set REPO_URL to the app repo}"
BRANCH="${BRANCH:-main}"
SPEC_DIR="${SPEC_DIR:-.}"
TAG="appeeky-spec/pushed"
LISTING="appeeky/store appeeky.spec.yaml"

log() { echo "[appeeky-spec $MODE] $*"; }

if [ "$MODE" = "schedule" ]; then
  crontab="$(mktemp)"
  {
    echo "${DAILY_AT:-0 6 * * *} appeeky-spec-run daily"
    if [ "${PUSH_EVERY:-}" != "off" ]; then echo "${PUSH_EVERY:-*/15 * * * *} appeeky-spec-run push"; fi
    if [ -n "${WEEKLY_AT:-}" ]; then echo "${WEEKLY_AT} appeeky-spec-run weekly"; fi
  } >"$crontab"
  log "Running on this schedule (UTC):"
  sed 's/^/  /' "$crontab"
  # Start following main right away, so the first merge after setup is pushed.
  if [ "${PUSH_EVERY:-}" != "off" ]; then appeeky-spec-run push || log "The first push check failed; it runs again on schedule."; fi
  # Full path: as PID 1, supercronic re-executes itself to reap child processes.
  exec /usr/local/bin/supercronic -passthrough-logs "$crontab"
fi

work="$(mktemp -d)"
finish() {
  status=$?
  rm -rf "$work"
  if [ "$MODE" = "daily" ] && [ -n "${HEALTHCHECK_URL:-}" ]; then
    if [ "$status" = 0 ]; then url="$HEALTHCHECK_URL"; else url="${HEALTHCHECK_URL%/}/fail"; fi
    curl -fsS -m 10 --retry 3 -o /dev/null "$url" || log "Could not reach HEALTHCHECK_URL."
  fi
  exit "$status"
}
trap finish EXIT

# Each run has its own git config: daily and push can start in the same minute.
export GIT_CONFIG_GLOBAL="$work/gitconfig"

# The token goes through a credential helper, so it never appears in a URL or a log.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
  export GH_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"
fi
git config --global user.name "${GIT_USER_NAME:-appeeky-spec}"
git config --global user.email "${GIT_USER_EMAIL:-spec@users.noreply.github.com}"

git clone --quiet --branch "$BRANCH" "$REPO_URL" "$work/repo"
cd "$work/repo/$SPEC_DIR"

# Commit what the routine wrote under appeeky/ and push it, on top of anything merged meanwhile.
save() {
  git add appeeky
  if git diff --cached --quiet; then log "Nothing to commit."; return 0; fi
  git commit --quiet -m "$1"
  git pull --quiet --rebase origin "$BRANCH"
  git push --quiet origin "HEAD:$BRANCH"
  log "Committed: $1"
}

# Remember the last commit the push routine handled, as a tag in the repo itself.
mark() {
  git tag -f "$TAG" HEAD >/dev/null
  git push --quiet --force origin "refs/tags/$TAG"
}

case "$MODE" in
  daily)
    appeeky-spec category pull || true
    appeeky-spec visibility pull || true
    appeeky-spec verify --playbook
    appeeky-spec reviews pull || true
    appeeky-spec competitors pull || true
    save "Daily: category, AI visibility, verify, reviews, competitors"
    ;;

  push)
    git fetch --quiet origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
    if ! git rev-parse --quiet --verify "refs/tags/$TAG" >/dev/null; then
      # First run: start from here. Pushing whatever main holds today could surprise someone.
      if [ "${PUSH_DRY_RUN:-}" = "1" ]; then log "Dry run: would start following main at $(git rev-parse --short HEAD)."; exit 0; fi
      mark
      log "Started at $(git rev-parse --short HEAD). Listing changes merged from now on are pushed."
      exit 0
    fi
    last="$(git rev-parse "refs/tags/$TAG^{commit}")"
    if [ "$last" = "$(git rev-parse HEAD)" ]; then log "Up to date."; exit 0; fi
    # shellcheck disable=SC2086
    if git diff --quiet "$last" HEAD -- $LISTING; then
      if [ "${PUSH_DRY_RUN:-}" != "1" ]; then mark; fi
      log "No listing change since $(git rev-parse --short "$last")."
      exit 0
    fi
    if [ "${PUSH_DRY_RUN:-}" = "1" ]; then
      log "Dry run: listing changed since $(git rev-parse --short "$last")."
      appeeky-spec push --dry-run
      exit 0
    fi
    # shellcheck disable=SC2086
    appeeky-spec push --yes --note "$(git log -1 --format=%s -- $LISTING)"
    save "Record release"
    # A change the store does not take yet (a new name or subtitle needs a new App Store
    # version) stays pending: keep the tag, so it is pushed once the version exists.
    pending="$(appeeky-spec push --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.stores??[]).reduce((n,p)=>n+p.changes.length,0))})')"
    if [ "$pending" != "0" ]; then
      log "$pending change(s) wait for the store (see above). Trying again on the next run."
      exit 0
    fi
    mark
    ;;

  weekly)
    command -v claude >/dev/null || { log "This image has no agent. Use the -agent image or build with --build-arg AGENT=1."; exit 1; }
    [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] || { log "Set CLAUDE_CODE_OAUTH_TOKEN (run \`claude setup-token\` on your computer) or ANTHROPIC_API_KEY."; exit 1; }
    prompt=".github/appeeky-propose.md"
    [ -f "$prompt" ] || { log "Missing $prompt (copy examples/weekly/propose.md)."; exit 1; }
    appeeky-spec data pull || true
    appeeky-spec reviews pull || true
    appeeky-spec competitors pull || true
    free="$(appeeky-spec status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).free.join(" ")))')"
    [ -n "$free" ] || { log "Every store has a release being measured."; exit 0; }
    rm -f .appeeky/proposal.md
    claude -p "$(cat "$prompt")

The CLI is installed as \`appeeky-spec\`: run it as \`appeeky-spec <command>\` instead of \`npx @appeeky/spec <command>\`.
Stores free to change: $free" --allowedTools "Read" "Edit" "Write" "Bash(appeeky-spec *)"
    # shellcheck disable=SC2086
    if git diff --quiet -- $LISTING || [ ! -f .appeeky/proposal.md ]; then log "Nothing proposed."; exit 0; fi
    branch="listing/weekly-$(date -u +%F)"
    git switch --quiet -c "$branch"
    # shellcheck disable=SC2086
    git add $LISTING
    git commit --quiet -m "$(head -1 .appeeky/proposal.md)"
    git push --quiet origin "$branch"
    gh pr create --base "$BRANCH" --title "$(head -1 .appeeky/proposal.md)" --body-file .appeeky/proposal.md
    ;;

  *)
    echo "Usage: MODE=daily|push|weekly|schedule appeeky-spec-run" >&2
    exit 2
    ;;
esac
