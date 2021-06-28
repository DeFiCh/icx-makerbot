# icx-makerbot
ICX Parity Maker Bot

## Purpose

This bot interfaces with DeFiChain node, monitors for available BTC and dBTC at specified address(es), adds the entirety of it to ICX as maker at parity, i.e. 1 BTC for 1dBTC and vice versa.

It also performs the neceesary steps to ensures the safety of the counter-party steps and follows through when it determines to be safe.

## Run the dBTC maker bot.
```
deno run --allow-net --allow-write --allow-read icx_bot_dbtc_maker.js DefiChain_Node_Ip RPC_PORT RPC_USER RPC_PASSWORD DFI_ADDRESS SPV_BTC_ADDRESS
```

For example:

```
deno run --allow-net --allow-write --allow-read icx_bot_dbtc_maker.js 127.0.0.1 18554 test test 7Jw72Q9yGJ1UWCXdQcUwkwSX48mkvdV2sS tb1qfdl5fs580x8ykqjngfvgdwhryu62r59q3tuaga
```