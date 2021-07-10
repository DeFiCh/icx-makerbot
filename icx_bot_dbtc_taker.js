import { rpcMethod, waitConfirmation, waitSPVConnected, sleep } from './util1.js';

const ownerAddress  = Deno.args[4];
const btcAddress    = Deno.args[5];

var btcPubkey;
const offerAmount = 0.0001;

(async() => {
    try{
        btcPubkey = (await rpcMethod('spv_getaddresspubkey', [btcAddress])).result;
        if (btcPubkey.length <= 0) {
            console.error("Don't have ownership of btc address: " + btcAddress);
            return;
        }
        console.log("Btc pubkey: " + btcPubkey);

        const orders = (await rpcMethod('icx_listorders')).result;
        let foundOrder = false;
        var orderId;
        var dbtcOrderDetails;

        for (var key in orders) {
            if (key == "WARNING")
                continue;

            // if (key != "b65784e0c8ac2afa3d40299eb3086a92f2cb6c61a5364ff1c5b4d832efda41fd")
            //     continue;

            if (orders.hasOwnProperty(key)) {
                console.log(key + " -> " + orders[key]);
                const orderDetails = orders[key];

                if (orderDetails["type"] == "INTERNAL" &&
                    orderDetails["tokenFrom"] == "BTC" &&
                    orderDetails["chainTo"] == "BTC" &&
                    orderDetails["orderPrice"] == 1)
                {
                    foundOrder = true;
                    orderId = key;
                    dbtcOrderDetails = orderDetails;
                    break;
                }
            }
        }

        if (!foundOrder) {
            console.log("Didn't find the dBTC maker order, quit");
            return;
        }

        console.log(`Found dBTC order ${orderId} `);

        console.log("Start to make offer");
        const offerTxId = await waitConfirmation(await rpcMethod('icx_makeoffer',
            [{"orderTx": orderId, "amount": offerAmount, "ownerAddress": ownerAddress, "expiry":300}]));
        console.log("made offer " + offerTxId + " to order " + orderId);

        // const offerTxId = "20e6248ed91ea316c2626d45a6aad9e512aa2edc04c9405d40ac2d85055e9839";
        // const dfchtlcTx = "8e61735a53526e52e722888b4d940e6d6d81ca2c88c7ce133c0c3da8b2e77629";
        // const spvHtlcAddress = "2N6fHZzA3D4tkNTTi8TLCbyVjBiwQaFNjC2";

        let foundHtlc = false;
        var dfchtlcTx;
        var dfcHtlcDetails;
        var spvHtlcAddress;
        while (!foundHtlc) {
            console.log(`Checking HTLC for offer ${offerTxId}`);
            const listHTLCs = (await rpcMethod('icx_listhtlcs', [{"offerTx": offerTxId}])).result;
            for (var key in listHTLCs) {
                if (key == "WARNING")
                    continue;

                console.log(key + " -> " + JSON.stringify(listHTLCs[key]));
                const htlcDetails = listHTLCs[key];
                if (htlcDetails["offerTx"] == offerTxId) {
                    dfchtlcTx = key;
                    dfcHtlcDetails = htlcDetails;

                    const SPV_TIMEOUT = 20;
                    // Create the HTLC on taker side
                    const spvHtlc = await waitSPVConnected(async () => {
                        return await rpcMethod('spv_createhtlc', [dbtcOrderDetails["receivePubkey"], btcPubkey, SPV_TIMEOUT.toString(), htlcDetails["hash"]]);
                    });
                    spvHtlcAddress = spvHtlc.result["address"];
                    console.log(`Created SPV result: ${JSON.stringify(spvHtlc)}`);

                    const extHtlcTxid = (await rpcMethod('icx_submitexthtlc',
                        [{
                            "offerTx": offerTxId, "hash": htlcDetails["hash"], "amount": htlcDetails["amountInEXTAsset"],
                            "htlcScriptAddress": spvHtlcAddress, "ownerPubkey": btcPubkey, "timeout": SPV_TIMEOUT
                        }])).result;
                    console.log(`icx_submitexthtlc result: ${JSON.stringify(extHtlcTxid)}`);

                    const spvFundTxid = (await waitSPVConnected(async () => {
                        return await rpcMethod('spv_sendtoaddress', [spvHtlcAddress, htlcDetails["amountInEXTAsset"]])
                    })).result;

                    console.log("Fund spv htlc with txid result: " + JSON.stringify(spvFundTxid));

                    foundHtlc = true;
                    break;
                }
            }
            await sleep(20000);
        }

        let claimedDfcHtlc = false;
        while (!claimedDfcHtlc) {
            console.log(`Checking seed of spv htlc `)
            const seed = (await rpcMethod('spv_gethtlcseed', [spvHtlcAddress])).result;
            if (seed.length <= 0) {
                await sleep(20000);
                continue;
            }
            console.log(`seed: ${seed}`);

            const dfcClaimTxid = (await rpcMethod('icx_claimdfchtlc', [{"dfchtlcTx": dfchtlcTx, "seed": seed}])).result;
            console.log("Claimed dBTC in txid: " + JSON.stringify(dfcClaimTxid));
            claimedDfcHtlc = true;
        }

        console.log("The whole process finished");
    }catch(e) {
        console.error(e);
    }
})();
