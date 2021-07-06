# Prerequisites

Before start test, make sure you have node sync with testnet and enabled spv. And node has DFI UTXO and DFI token balances, also has BTC token balance. After test, you will get BTC and cost BTC token.

# Steps to test the BTC maker bot.

1. Get orders.

```
./defi-cli icx_listorders
```

Example reply.

```
{
  "WARNING": "ICX and Atomic Swap are experimental features. You might end up losing your funds. USE IT AT YOUR OWN RISK.",
  "dfc9c242791bb6db84d04cb902c44a2808fd0cdec3f53a28eff3f174493c2462": {
    "status": "OPEN",
    "type": "EXTERNAL",
    "chainFrom": "BTC",
    "tokenTo": "DFI",
    "ownerAddress": "tk7nuNxJ96tCAM57eT7Wx6pQYut8yReoZt",
    "amountFrom": 0.00010000,
    "amountToFill": 0.00010000,
    "orderPrice": 10.00000000,
    "amountToFillInToAsset": 0.00100000,
    "height": 378291,
    "expireHeight": 381171
  }
}
```

2. Taker maker offer. "ownerAddress" is the taker's DFI legacy address, "receivePubkey" is the taker's BTC pubkey, can get by command `spv_getaddresspubkey`

```
./defi-cli icx_makeoffer '{"orderTx":"dfc9c242791bb6db84d04cb902c44a2808fd0cdec3f53a28eff3f174493c2462","amount":0.0001,"ownerAddress":"tk7nuNxJ96tCAM57eT7Wx6pQYut8yReoZt","receivePubkey":"030eac7e179cf91d2dd3f275a2517e23564679a28e19e9bdd251cc8afdaf90cde1","expiry":200}'
```

3. Taker continually check if the maker accepted the offer by command.

```
./defi-cli icx_listhtlcs '{"offerTx":"4f763da1bfa9e3f4a333cfdb28071a87b44613294b108edef052117a22dac18f"}'
```

Example reply when the offer is accepted.

```
{
  "WARNING": "ICX and Atomic Swap are experimental features. You might end up losing your funds. USE IT AT YOUR OWN RISK.",
  "2506977427d491478a24c0e32b8a86a30005405b7feea6c84627fabfb7a9d237": {
    "type": "EXTERNAL",
    "status": "OPEN",
    "offerTx": "4f763da1bfa9e3f4a333cfdb28071a87b44613294b108edef052117a22dac18f",
    "amount": 0.00010000,
    "amountInDFCAsset": 0.00010000,
    "hash": "bef9bf8f46ce1eea7a47725fe4613d574e79ce633ad7d8046da06ad040dcac41",
    "htlcScriptAddress": "2NAuLuHtM8h7vEceNkh9xjh9CRximBNtLd4",
    "ownerPubkey": "03668b5dc4f33dab92cd5b70c034a88e0d2510b14e39f3995245acb4d8723c2b35",
    "timeout": 40,
    "height": 419930
  }
}
```

4. Taker recreate the same btc htlc with the given hash, the hash can be known from last command icx_listhtlcs step's "hash". The first parameter is the taker's BTC pubkey, the second parameter is the `ownerPubkey` in last step's reply,
the third parameter is the `timeout` is last step's reply, the forth parameter is `hash` in last step's reply.

```
./defi-cli spv_createhtlc 030eac7e179cf91d2dd3f275a2517e23564679a28e19e9bdd251cc8afdaf90cde1 03668b5dc4f33dab92cd5b70c034a88e0d2510b14e39f3995245acb4d8723c2b35 40 bef9bf8f46ce1eea7a47725fe4613d574e79ce633ad7d8046da06ad040dcac41
```

Example reply.

```
{
  "address": "2NAuLuHtM8h7vEceNkh9xjh9CRximBNtLd4",
  "redeemScript": "63a820bef9bf8f46ce1eea7a47725fe4613d574e79ce633ad7d8046da06ad040dcac418821030eac7e179cf91d2dd3f275a2517e23564679a28e19e9bdd251cc8afdaf90cde1670128b2752103668b5dc4f33dab92cd5b70c034a88e0d2510b14e39f3995245acb4d8723c2b3568ac"
}
```

5. Check if balance on BTC HTLC address is same as in offer

```
./defi-cli spv_listreceivedbyaddress 1 "2NAuLuHtM8h7vEceNkh9xjh9CRximBNtLd4"
```

Example reply.

```
[
  {
    "address": "2NAuLuHtM8h7vEceNkh9xjh9CRximBNtLd4",
    "type": "HTLC",
    "amount": 0.00010000,
    "confirmations": 1,
    "txids": [
      "f537b936c03f7cc035b7982bce026c8cf141553d02bd113f16de4381b6583546"
    ]
  }
]
```

6. If check the amount in step 4 is correct, submit the DefiChain HTLC. `hash` parameter must be the same as the forth parameter of `spv_createhtlc`.

```
./defi-cli icx_submitdfchtlc '{"offerTx":"4f763da1bfa9e3f4a333cfdb28071a87b44613294b108edef052117a22dac18f","amount":0.0001,"hash":"bef9bf8f46ce1eea7a47725fe4613d574e79ce633ad7d8046da06ad040dcac41"}'
```

7. Continually check if maker claimed the DefiChain htlc. If find the reply of below command has "type" is "CLAIM DFC", it means maker already claimed DefiChain HTLC.

```
./defi-cli icx_listhtlcs '{"offerTx":"4f763da1bfa9e3f4a333cfdb28071a87b44613294b108edef052117a22dac18f"}'
```

Example reply.

```
{
  "WARNING": "ICX and Atomic Swap are experimental features. You might end up losing your funds. USE IT AT YOUR OWN RISK.",
  "0edeb6055727a667e144fb60b1dc2168d827218ce1c7001c593db52f2535ac2f": {
    "type": "CLAIM DFC",
    "dfchtlcTx": "924bcc896c06a71c12c34ca398555fd1e81f65f2990792ff13815548823e52ce",
    "seed": "4fccdc088e2d41013b0c6ff3763fc4d8a9224027773b1ddc8c0c4ae08f48f3c3",
    "height": 419959
  }
}
```

8. Taker claim the SPV HTLC using last step's seed.

```
./defi-cli spv_claimhtlc "2NAuLuHtM8h7vEceNkh9xjh9CRximBNtLd4" "tb1qvwch6aa9945sxryye70u6gl76celcfec7nkfcj" "4fccdc088e2d41013b0c6ff3763fc4d8a9224027773b1ddc8c0c4ae08f48f3c3"
```
