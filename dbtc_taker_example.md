# Prerequisites

Before start test, make sure you have node sync with testnet and enabled spv. And node has DFI UTXO and DFI token balances, also has SPV BTC balance. After test, you will get BTC token and cost BTC.

# Steps to test the dBTC maker bot.

1. Get orders.

```
./defi-cli icx_listorders
```

Example reply.

```
{
  "WARNING": "ICX and Atomic Swap are experimental features. You might end up losing your funds. USE IT AT YOUR OWN RISK.",
  "5e3986d18662db1600eaa682543ff17ce7496943d58cd577984f56df6983bc70": {
    "status": "OPEN",
    "type": "INTERNAL",
    "tokenFrom": "BTC",
    "chainTo": "BTC",
    "receivePubkey": "03668b5dc4f33dab92cd5b70c034a88e0d2510b14e39f3995245acb4d8723c2b35",
    "ownerAddress": "7Jw72Q9yGJ1UWCXdQcUwkwSX48mkvdV2sS",
    "amountFrom": 0.10000000,
    "amountToFill": 0.10000000,
    "orderPrice": 1.00000000,
    "amountToFillInToAsset": 0.10000000,
    "height": 412719,
    "expireHeight": 415599
  }
}
```

2. Taker maker offer.

```
./defi-cli icx_makeoffer '{"orderTx":"5e3986d18662db1600eaa682543ff17ce7496943d58cd577984f56df6983bc70","amount":0.0001,"ownerAddress":"tk7nuNxJ96tCAM57eT7Wx6pQYut8yReoZt","expiry":300}'
```

3. Check if maker accepted the offer. Wait for the below command has reply.

```
./defi-cli icx_listhtlcs '{"offerTx":"96ff828f54e870e5e8e8040e2b78804765ead4f932fe32a2189206c5eb368449"}'
```

Example reply.
```
{
  "WARNING": "ICX and Atomic Swap are experimental features. You might end up losing your funds. USE IT AT YOUR OWN RISK.",
  "da94df627e829e59372287cf89dd98bc9afbd5326d72af22db2d453f91e13a0d": {
    "type": "DFC",
    "status": "OPEN",
    "offerTx": "96ff828f54e870e5e8e8040e2b78804765ead4f932fe32a2189206c5eb368449",
    "amount": 0.00010000,
    "amountInEXTAsset": 0.00010000,
    "hash": "5102a292d7efa74fcc780439bb02c87bb71328a15882197b7ab4d7400cab2123",
    "timeout": 500,
    "height": 412729,
    "refundHeight": 413229
  }
}
```

4. Taker after see the above DefiChain htlc, also create on SPV. The first parameter is maker's BTC public key, it can be find the result of `icx_listorders`, the parameter "receivePubkey".  The second parameter is the taker's BTC pubkey, it can be get by command `spv_getaddresspubkey`. The forth parameter is the `hash` in last step result of `icx_listhtlcs`.

```
./defi-cli spv_createhtlc 03668b5dc4f33dab92cd5b70c034a88e0d2510b14e39f3995245acb4d8723c2b35 030eac7e179cf91d2dd3f275a2517e23564679a28e19e9bdd251cc8afdaf90cde1 30 5102a292d7efa74fcc780439bb02c87bb71328a15882197b7ab4d7400cab2123
```

Example reply.

```
{
  "address": "2MzgDdVwmdPo8fEDuCm8qK3NHsVJhfqsLSW",
  "redeemScript": "63a8205102a292d7efa74fcc780439bb02c87bb71328a15882197b7ab4d7400cab2123882103668b5dc4f33dab92cd5b70c034a88e0d2510b14e39f3995245acb4d8723c2b35670114b27521030eac7e179cf91d2dd3f275a2517e23564679a28e19e9bdd251cc8afdaf90cde168ac"
}
```

5. Fund the last step's SPV HTLC.

```
./src/defi-cli -testnet -rpcport=18554 -rpcuser=test -rpcpassword=test spv_sendtoaddress 2MzgDdVwmdPo8fEDuCm8qK3NHsVJhfqsLSW 0.0001

```

6. Submit the external HTLC to DFI. "htlcScriptAddress" is the address created by RPC `spv_createhtlc` in step 4. The `hash` is the `hash` in last step result of `icx_listhtlcs`. The `timeout` should be the same as the timeout used in step 4 to create spv HTLC.

```
./src/defi-cli -testnet -rpcport=18554 -rpcuser=test -rpcpassword=test icx_submitexthtlc '{"offerTx":"96ff828f54e870e5e8e8040e2b78804765ead4f932fe32a2189206c5eb368449","hash":"5102a292d7efa74fcc780439bb02c87bb71328a15882197b7ab4d7400cab2123","amount":"0.0001","htlcScriptAddress":"2MzgDdVwmdPo8fEDuCm8qK3NHsVJhfqsLSW","ownerPubkey":"030eac7e179cf91d2dd3f275a2517e23564679a28e19e9bdd251cc8afdaf90cde1","timeout":30}'
```

7. Taker continually check if the maker claimed the SPV HTLC by below command until it get the HTLC seed.

```
./src/defi-cli -testnet -rpcport=18554 -rpcuser=test -rpcpassword=test spv_gethtlcseed 2MzgDdVwmdPo8fEDuCm8qK3NHsVJhfqsLSW
```

8. Taker using the seed to claim DefiChain htlc. The DefiChain HTLC `dfchtlcTx` is in reply of `icx_listhtlcs` of step 3.

```
./src/defi-cli -testnet -rpcport=18554 -rpcuser=test -rpcpassword=test icx_claimdfchtlc '{"dfchtlcTx":"da94df627e829e59372287cf89dd98bc9afbd5326d72af22db2d453f91e13a0d","seed":"5026297f7c0455b55c49042d1c319fe046edc4141b50e5e1e06289d97f73a84e"}'
```
