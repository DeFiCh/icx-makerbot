import { rpcMethod, waitConfirmation, ownerAddress, waitSPVConnected, createSeedHashPair, sleep } from './util.js';

const maxOrderSize = 0.1;
const btcReceiveAddress = Deno.args[5];
let btcReceiverPubkey = "";

let mapOfferData = new Map();
let objOfferSpvHtlc = new Object();
let mapOfferSpvClaim = new Map();
let objHashSeed = new Object();

async function createOrderIfNotExist() {
    const orders = (await rpcMethod('icx_listorders')).result;
    //console.log(orders)
    var foundOrder = false;
    for (var key in orders) {
        if (key == "WARNING")
            continue;
        if (orders.hasOwnProperty(key)) {
            console.log(key + " -> " + orders[key]);
            const orderDetails = orders[key];
            if (orderDetails["type"] == "INTERNAL" &&
                orderDetails["ownerAddress"] == ownerAddress &&
                orderDetails["tokenFrom"] == "BTC" &&
                orderDetails["chainTo"] == "BTC") {
                console.log("Found order " + key);
                return key;
            }
        }
    }

    if (!foundOrder) {
        const accountBalance = (await rpcMethod('getaccount', [ownerAddress])).result;
        var btcBalance = 0;
        console.log("Account balance " + accountBalance);
        accountBalance.forEach((item) => {
            if (item.includes("@BTC")) {
                btcBalance = parseFloat(item);
                return;
            }
        })
        console.log("BTC balance " + btcBalance);
        if (btcBalance <= 0) {
            return;
        }

        let orderSize = btcBalance;
        if (orderSize > maxOrderSize) {
            orderSize = maxOrderSize;
        }

        console.log("Creating order with size " + orderSize);
        const orderTxId = await waitConfirmation(await rpcMethod('icx_createorder',
            [{"ownerAddress": ownerAddress, "tokenFrom": "BTC", "chainTo": "BTC", "amountFrom": orderSize, "orderPrice": 1, "receivePubkey": btcReceiverPubkey}]));
        console.log("created order " + orderTxId);
        return orderTxId;
    }
}

async function checkExistingDfcHtlc(offerId) {
    console.log("checkExistingDfcHtlc for offerId: " + offerId);
    if (mapOfferData.has(offerId)) {
        console.log("Offer " + offerId + " already has dfc htlc " + mapOfferData.get(offerId)["dfchtlc"])
        return;
    }

    const listHtlcs = (await rpcMethod('icx_listhtlcs', [{"offerTx": offerId}])).result;
    console.log("checkExistingDfcHtlc icx_listhtlcs result: " + JSON.stringify(listHtlcs));

    for (var key in listHtlcs) {
        if (key == "WARNING") {
            continue;
        }

        const htlcDetails = listHtlcs[key];
        if (htlcDetails["type"] == "DFC" && htlcDetails["status"] == "OPEN") {
            const htlcDetails = listHtlcs[key];
            const hash = htlcDetails["hash"];
            const seed = objHashSeed[hash];
            console.log("Seed: " + seed);

            let offerData = {"seed": seed, "hash": hash, "dfchtlc": key, "timeout": htlcDetails["timeout"], "amount": htlcDetails["amount"] };
            mapOfferData.set(offerId, offerData);
        }
    }
}

async function acceptOfferIfAny(orderId) {
    if (orderId.length <= 0) {
        console.error("empty order id input");
        return;
    }

    const listOrderOffers = (await rpcMethod('icx_listorders', [{"orderTx": orderId}])).result;

    for (var key in listOrderOffers) {
        if (key == "WARNING")
            continue;

        await checkExistingDfcHtlc(key);
    }

    for (var key in listOrderOffers) {
        if (key == "WARNING")
            continue;

        if (mapOfferData.has(key)) {
            console.log("Order " + orderId + " already has offer " + key);
            continue;
        }

        console.log(key + " -> " + listOrderOffers[key]);
        const offerDetails = listOrderOffers[key];
        console.log(`Order detail: ${JSON.stringify(offerDetails)}`);
        if (offerDetails["status"] == "OPEN") {
            const seedHashPair = createSeedHashPair();
            const seed = seedHashPair.seed;
            const hash = seedHashPair.hash;
            console.log(`Seed/Hash generated: ${seed}/${hash}`);

            objHashSeed[hash] = seed;
            Deno.writeTextFileSync("./hashseed.json", JSON.stringify(objHashSeed));

            const timeout = 500; // Must grater than 499, because CICXSubmitDFCHTLC::MINIMUM_TIMEOUT limit.
            const dfcHtlcTxid = await waitConfirmation(await rpcMethod('icx_submitdfchtlc',
                [{ "offerTx": key, "hash": hash, "amount": offerDetails["amount"], "timeout": timeout }]));

            let offerData = {"seed": seed, "hash": hash, "dfchtlc": dfcHtlcTxid, "timeout": timeout, "amount": offerDetails["amount"] };
            mapOfferData.set(key, offerData);
        }
    }
}

async function checkOfferSpvHtlc(offerData, offerId) {
    console.log("Checking spv htlc of offer " + offerId);

    if (mapOfferSpvClaim.has(offerId)) {
        console.log("Offer id: " + offerId + " already claimed in btc tx " + mapOfferSpvClaim.get(offerId));
        return;
    }

    if (objOfferSpvHtlc.hasOwnProperty(offerId)) {
        console.log("Offer " + offerId + " already has spv htlc " + objOfferSpvHtlc[offerId]);
        return;
    }

    const listHtlcs = (await rpcMethod('icx_listhtlcs', [{"offerTx": offerId}])).result;
    console.log("icx_listhtlcs result: " + JSON.stringify(listHtlcs));
    for (var key in listHtlcs) {
        if (key == "WARNING")
            continue;

        const htlcDetails = listHtlcs[key];
        if (htlcDetails["type"] == "EXTERNAL" && htlcDetails["status"] == "OPEN") {
            // ReCreate the same HTLC on maker side. Note. the timeout input is a string but not a number
            // If input number, will have "JSON value is not a string as expected" error.
            const spvHtlc = await waitSPVConnected(async () => {
                return await rpcMethod('spv_createhtlc', [btcReceiverPubkey, htlcDetails["ownerPubkey"], htlcDetails["timeout"].toString(), htlcDetails["hash"]]);
            });

            objOfferSpvHtlc[offerId] = spvHtlc.result["address"];

            Deno.writeTextFileSync("./offerspvhtlc.json", JSON.stringify(objOfferSpvHtlc));
            console.log("spv_createhtlc address result: " + objOfferSpvHtlc[offerId]);
        }
    }
}

async function checkHtlcOutputAndClaim(offerId) {
    if (mapOfferSpvClaim.has(offerId)) {
        console.log("Offer id: " + offerId + " already claimed in btc tx " + mapOfferSpvClaim.get(offerId));
        return;
    }

    const spvHtlc = objOfferSpvHtlc[offerId];
    console.log("Check output of spv htlc: " + spvHtlc);

    const listSpvReceived = (await rpcMethod('spv_listreceivedbyaddress', [1, spvHtlc])).result;
    console.log("spv_listreceivedbyaddress result " + JSON.stringify(listSpvReceived));
    console.log("listSpvReceived.length: " + Object.keys(listSpvReceived).length);
    if (Object.keys(listSpvReceived).length > 0) {
        if (!mapOfferData.has(offerId)) {
            console.error("Offer " + offerId + " don't have htlc data");
            return;
        }
        const offerData = mapOfferData.get(offerId);
        const claimInput = [spvHtlc, btcReceiveAddress, offerData["seed"]];
        console.log("spv_claimhtlc input: " + JSON.stringify(claimInput));
        const claimBtcTxid = await waitSPVConnected(async () => {
            return await rpcMethod('spv_claimhtlc', claimInput, false, false);
        });
        console.log("SPV claim txid: " + claimBtcTxid.result["txid"]);
        mapOfferSpvClaim.set(offerId, claimBtcTxid);

        // Erase the offer spv htlc, so don't check again.
        delete objOfferSpvHtlc[offerId];
        Deno.writeTextFileSync("./offerspvhtlc.json", JSON.stringify(objOfferSpvHtlc));
    }
}

async function loadExistingData() {
    try {
        const texthashseed = Deno.readTextFileSync("./hashseed.json");
        if (texthashseed.length > 0) {
            objHashSeed = JSON.parse(texthashseed);
            console.log("objHashSeed: " + JSON.stringify(objHashSeed));
        }
    } catch (e) {
        console.log("Skipped to load hashseed.json");
    }

    try {
        const textofferspvhtlc = Deno.readTextFileSync("./offerspvhtlc.json");
        if (textofferspvhtlc.length > 0) {
            objOfferSpvHtlc = JSON.parse(textofferspvhtlc);
            console.log("objOfferSpvHtlc: " + JSON.stringify(objOfferSpvHtlc));
        }
    }catch (e) {
        console.log("Skipped to load offerspvhtlc.json");
    }
}

(async() => {
    try{

        if (!btcReceiveAddress || btcReceiveAddress.length <= 0) {
            console.error("Please input the btc receiver address");
            return;
        }
        
        loadExistingData();

        btcReceiverPubkey = (await rpcMethod('spv_getaddresspubkey', [btcReceiveAddress])).result;
        if (btcReceiverPubkey.length <= 0) {
            console.error("Don't have ownership of btc address: " + btcReceiveAddress);
            return;
        }
        console.log("Btc pubkey: " + btcReceiverPubkey);

        while(true) {
            const orderTxId = await createOrderIfNotExist(btcReceiverPubkey);

            await acceptOfferIfAny(orderTxId);
            
            await mapOfferData.forEach(checkOfferSpvHtlc);

            for (var offerId in objOfferSpvHtlc) {
                await checkHtlcOutputAndClaim(offerId);
            }

            await sleep(20000);
        }
    }catch(e) {
        console.error(e);
    }
})();
