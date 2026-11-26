# Launch Scalper — Pump.fun Bot Sprint

[![Competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/semutadv/botsprint-entry/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/semutadv/botsprint-entry/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the make.fun pump.fun bot sprint, speaking the
agent-fun/replay/v2 line protocol on stdin/stdout.

Thesis: almost every pump.fun launch is dead within the hour, and the only
slice of its life that is reliably tradeable is the opening burst — the
first seconds, when the creator's own buy and the first outside wallets hit
the curve. The bot therefore buys only launches that pass a rug filter in
their first slots (creator has real skin in the launch and has not sold,
few outside buyers so the launch is not a bundle, buy volume dominating,
price already stepping up but not yet vertical), and leaves again within
half a minute of slots: profit target, stop loss, hard time stop, and an
instant exit the moment the creator sells. Stakes are small and flat, so
no single rug matters.

`main.ts` is the whole bot: no dependencies, no network, no files — a pure
function of the batches the harness sends. Run it with Node 22:

```
node main.ts
```

## License

MIT — see `LICENSE`.
