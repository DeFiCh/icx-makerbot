# icx-makerbot
ICX Parity Maker Bot

## Purpose

This bot interfaces with DeFiChain node, monitors for available BTC and dBTC at specified address(es), adds the entirety of it to ICX as maker at parity, i.e. 1 BTC for 1dBTC and vice versa.

It also performs the necessary steps to ensures the safety of the counter-party steps and follows through when it determines to be safe.

## Installation

This script requires Deno to be installed: https://deno.land/

## Prerequisites

The parameters are pass in to the script by environment variables, need to define 7 environment variables in `.bash_profile`. The `ALARM_HOOK` is optional.

```
export RPC_ADDRESS=127.0.0.1
export RPC_PORT=18554
export RPC_USER=user
export RPC_PASSWORD=password
export DFI_ADDRESS=7Jw72Q9yGJ1UWCXdQcUwkwSX48mkvdV2sS
export SPV_BTC_ADDRESS=tb1qfdl5fs580x8ykqjngfvgdwhryu62r59q3tuaga
export ALARM_HOOK="The slack webhook url"
```

## Run the dBTC maker bot.

Before run the script, make sure the account has enough dBTC token and DFI token, also need to have DFI utxos.

```
deno run --allow-all icx_bot_dbtc_maker.js
```

## Run the BTC maker bot.

Before run the script, make sure the account has enough BTC and DFI token, also need to have DFI utxos.

```
deno run --allow-all icx_bot_btc_maker.js
```
