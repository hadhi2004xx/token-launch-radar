# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/hadhi2004xx/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/hadhi2004xx/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar built from a sealed DefiLlama snapshot of 758 protocols. It finds the protocols that still record no token and are not a wrapped or staked product of one that trades, then ranks 198 of them by implied value: each protocol's TVL multiplied by the median market-cap-to-TVL multiple of tokenised protocols in its own category, adjusted for seven-day momentum, for how long it has run with no token, and for chain spread. Every row carries a concrete farm plan with costs and cadence. The offline dashboard sorts and filters the board and opens a detail view per protocol showing the model's working.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=2ym2spy1&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
