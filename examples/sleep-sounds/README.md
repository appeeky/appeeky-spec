# Example: Sleep Sounds

A spec repo two months in, to look around without setting anything up. The listing is under
`appeeky/store/`; everything else is what the commands write as you work:

| Look at | What it shows |
| --- | --- |
| `appeeky/loops.md` | what is being measured now, what is due, what came out (`status`) |
| `appeeky/releases/` | three pushes: the change, the ranks before it, the day 7 and 14 checks with the control group and the numbers |
| `appeeky/experiments/` | a UGC experiment with its own smart link (won) and a screenshot test still running |
| `appeeky/playbook.md` | what worked, in one line each |
| `appeeky/competitors/changes.md` | what Calm Night changed, and when |
| `appeeky/reviews/summary.md` | ratings, replies waiting, and words users use that the listing does not |

Try it from the repo root:

```sh
node dist/bin.js --cwd examples/sleep-sounds status --all
node dist/bin.js --cwd examples/sleep-sounds check
node dist/bin.js --cwd examples/sleep-sounds coverage --country us
```

The numbers are made up. Dates are relative to early November 2026, so `status` shows more
checks as late the later you run it.
