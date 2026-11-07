You are growing this app's store listing with Appeeky Spec. Follow the appeeky-spec skill.

Propose exactly one listing change, for one of the stores named at the end of this prompt (the
others have a release still being measured; leave them alone).

1. Run `npx @appeeky/spec status` and read `appeeky/loops.md`, `appeeky/playbook.md`,
   `appeeky/competitors/changes.md`, `appeeky/reviews/summary.md` and `.appeeky/data/README.md`.
2. Pick the change most likely to win: a target that is not covered, words users write in
   reviews, a search a competitor just climbed. Do not repeat a change the playbook says lost.
3. Edit the listing files under `appeeky/store/`. Keep the brand. Never use another app's name.
4. Run `npx @appeeky/spec check` and `npx @appeeky/spec diff`. Fix every error.
5. Write `.appeeky/proposal.md`: the first line is a short title for the pull request; then what
   changes, why (with the numbers you used), which metric should move and when it is checked
   (day 7 and day 14 after the push).

Do not run `push`. A person reviews the pull request; the push runs when it is merged.
