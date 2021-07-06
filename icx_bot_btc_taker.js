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
        var btcOrderDetails;

        for (var key in orders) {
            if (key == "WARNING")
                continue;
            if (orders.hasOwnProperty(key)) {
                console.log(key + " -> " + orders[key]);
                const orderDetails = orders[key];
                if (orderDetails["type"] == "EXTERNAL" &&
                    orderDetails["chainFrom"] == "BTC" &&
                    orderDetails["tokenTo"] == "BTC" &&
                    orderDetails["orderPrice"] == 1)
                {
                    foundOrder = true;
                    orderId = key;
                    btcOrderDetails = orderDetails;
                    break;
                }
            }
        }

        if (!foundOrder) {
            console.log("Didn't find the BTC maker order, quit");
            return;
        }

        console.log(`Found BTC order ${orderId}`);

        console.log("Start to make offer");
        const offerTxId = await waitConfirmation(await rpcMethod('icx_makeoffer',
            [{"orderTx": orderId, "amount": offerAmount, "ownerAddress": ownerAddress, "receivePubkey": btcPubkey, "expiry":200}]));
        console.log("made offer " + offerTxId + " to order " + orderId);

        let foundHtlc = false;
        var extHtlcDetails;
        var spvHtlcAddress;
        while (!foundHtlc) {
            console.log(`Checking HTLC for offer ${offerTxId}`);
            const listHTLCs = (await rpcMethod('icx_listhtlcs', [{"offerTx": offerTxId}])).result;
            for (var key in listHTLCs) {
                if (key == "WARNING")
                    continue;

                console.log(key + " -> " + JSON.stringify(listHTLCs[key]));
                const htlcDetails = listHTLCs[key];
                if (htlcDetails["offerTx"] == offerTxId &&
                    htlcDetails["type"] == "EXTERNAL" &&
                    htlcDetails["status"] == "OPEN")
                {
                    extHtlcDetails = htlcDetails;

                    // Recreate the same HTLC on taker side
                    const spvHtlc = await waitSPVConnected(async () => {
                        return await rpcMethod('spv_createhtlc', [btcPubkey, htlcDetails["ownerPubkey"], htlcDetails["timeout"].toString(), htlcDetails["hash"]]);
                    });
                    spvHtlcAddress = spvHtlc.result["address"];
                    console.log(`Created SPV result: ${JSON.stringify(spvHtlc)}`);

                    foundHtlc = true;
                    break;
                }
            }
            await sleep(20000);
        }

        while (true) {
            const listSpvReceived = (await rpcMethod('spv_listreceivedbyaddress', [1, spvHtlcAddress])).result;
            console.log("spv_listreceivedbyaddress result " + JSON.stringify(listSpvReceived));
            console.log("listSpvReceived.length: " + Object.keys(listSpvReceived).length);
            if (Object.keys(listSpvReceived).length <= 0) {
                await sleep(20000);
                continue;
            }
            
            if (listSpvReceived[0]["amount"] != offerAmount) {
                console.error("The spv received amount not match with offer amount!");
                return;
            }
            break;
        }

        const dfcHtlcTxid = await waitConfirmation(await rpcMethod('icx_submitdfchtlc',
                [{ "offerTx": offerTxId, "hash": extHtlcDetails["hash"], "amount": extHtlcDetails["amountInDFCAsset"]}]));

        console.log(`icx_submitdfchtlc result: ${dfcHtlcTxid}`);

        let claimedSpvHtlc = false;
        while (!claimedSpvHtlc) {
            console.log(`Checking HTLC for offer ${offerTxId}`);
            const listHTLCs = (await rpcMethod('icx_listhtlcs', [{"offerTx": offerTxId}])).result;
            for (var key in listHTLCs) {
                if (key == "WARNING")
                    continue;

                console.log(key + " -> " + JSON.stringify(listHTLCs[key]));
                const htlcDetails = listHTLCs[key];
                if (htlcDetails["dfchtlcTx"] == dfcHtlcTxid &&
                    htlcDetails["type"] == "CLAIM DFC")
                {
                    console.log("Start to claim the spv htlc");
                    // Claim the SPV HTLC
                    const claimTxId = (await waitSPVConnected(async () => {
                        return await rpcMethod('spv_claimhtlc', [spvHtlcAddress, btcAddress, htlcDetails["seed"]]);
                    })).result;
                    console.log(`spv_claimhtlc result: ${JSON.stringify(claimTxId)}`);

                    claimedSpvHtlc = true;
                    break;
                }
            }
            await sleep(20000);
        }

        console.log("The whole process finished");

    }catch(e) {
        console.error(e);
    }
})();
