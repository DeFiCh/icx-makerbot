import { rpcMethod, waitConfirmation, waitSPVConnected, createSeedHashPair, sleep } from './util.js';

const maxOrderSize = 0.1;
const minOrderLife = 500;
const ownerAddress = Deno.env.get("DFI_ADDRESS");
const btcMakerAddress = Deno.env.get("SPV_BTC_ADDRESS");
let btcMakerPubkey = "";
const alarmHook = Deno.env.get("ALARM_HOOK");

let mapOfferData = new Map();
let mapOfferDfcClaim = new Map();
let objHashSeed = new Object();

async function sendAlarm(msg) {
    if (alarmHook == null)
        return;

    fetch(alarmHook, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ "text": msg }),
    });
}

async function createOrderIfNotExist() {
    const orders = (await rpcMethod('icx_listorders')).result;
    var foundOrder = false;
    for (var key in orders) {
        if (key == "WARNING")
            continue;
        if (orders.hasOwnProperty(key)) {
            console.log(key + " -> " + orders[key]);
            const orderDetails = orders[key];
            if (orderDetails["type"] == "EXTERNAL" &&
                orderDetails["ownerAddress"] == ownerAddress &&
                orderDetails["chainFrom"] == "BTC" &&
                orderDetails["tokenTo"] == "BTC")
            {
                const chainInfo = (await rpcMethod('getblockchaininfo')).result;
                const headerBlock = chainInfo["headers"];
                console.log(`Order ${key} expiration height ${orderDetails["expireHeight"]}, blockchain header block ${headerBlock}`);
                if (orderDetails["expireHeight"] > headerBlock + minOrderLife) {
                    console.log("Found order " + key);
                    return key;
                }else {
                    console.log(`Order ${key} is too old, close it`);
                    const closeTxid = await waitConfirmation(await rpcMethod('icx_closeorder', [key]), 0, true);
                    console.log(`Order ${key} is closed in tx ${closeTxid}`);
                }
            }
        }
    }

    if (!foundOrder) {
        const btcBalance = parseFloat((await rpcMethod('spv_getbalance', [])).result);
        console.log("BTC balance " + btcBalance);
        if (btcBalance <= 0.0001) {
            console.error("BTC balance too low");
            return;
        }

        let orderSize = btcBalance;
        if (orderSize > maxOrderSize) {
            orderSize = maxOrderSize;
        }

        console.log("Creating order with size " + orderSize);
        const orderTxId = await waitConfirmation(await rpcMethod('icx_createorder',
            [{"ownerAddress": ownerAddress, "chainFrom": "BTC", "tokenTo": "BTC", "amountFrom": orderSize, "orderPrice": 1}]), 0, true);
        if (orderTxId["error"] != null) {
            sendAlarm("btc maker icx_createorder failed");
            Deno.exit();
        }
        console.log("created order " + orderTxId);
        return orderTxId;
    }
}

async function checkExistingExtHtlc(offerId) {
    console.log("checkExistingExtHtlc for offerId: " + offerId);
    if (mapOfferData.has(offerId)) {
        console.log("Offer " + offerId + " already has ext htlc " + mapOfferData.get(offerId)["exthtlc"])
        return;
    }

    const listHtlcs = (await rpcMethod('icx_listhtlcs', [{"offerTx": offerId}])).result;
    console.log("checkExistingExtHtlc icx_listhtlcs result: " + JSON.stringify(listHtlcs));

    for (var key in listHtlcs) {
        if (key == "WARNING") {
            continue;
        }

        const htlcDetails = listHtlcs[key];
        if (htlcDetails["type"] == "EXTERNAL" && htlcDetails["status"] == "OPEN" && htlcDetails["offerTx"] == offerId) {
            const htlcDetails = listHtlcs[key];
            const hash = htlcDetails["hash"];
            const seed = objHashSeed[hash];
            console.log("Seed: " + seed);

            let offerData = {"seed": seed, "hash": hash, "exthtlc": key, "timeout": htlcDetails["timeout"], "amount": htlcDetails["amount"] };
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

        // Check if accepted the offer already. Because may restarted the script.
        await checkExistingExtHtlc(key);
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
            const btcTakerPubkey = offerDetails["receivePubkey"];
            const SPV_TIME = 40;
            // Create the on maker side. Note. the timeout input is a string but not a number
            // If input number, will have "JSON value is not a string as expected" error.
            const spvHtlc = await waitSPVConnected(async () => {
                return await rpcMethod('spv_createhtlc', [btcTakerPubkey, btcMakerPubkey, SPV_TIME.toString()]);
            });

            if (spvHtlc["error"] != null) {
                sendAlarm("btc maker spv_createhtlc failed");
                continue;
            }

            console.log("spv_createhtlc result: " + JSON.stringify(spvHtlc.result));
            
            const seed = spvHtlc.result["seed"];
            const hash = spvHtlc.result["seedhash"];
            console.log(`Seed/Hash generated: ${seed}/${hash}`);

            objHashSeed[hash] = seed;
            Deno.writeTextFileSync("./hashseed.json", JSON.stringify(objHashSeed));

            const timeout = 500; // Must grater than 499, because CICXSubmitDFCHTLC::MINIMUM_TIMEOUT limit.
            const extHtlcTxid = await waitConfirmation(await rpcMethod('icx_submitexthtlc',
                [{"offerTx": key, "hash": hash, "amount": offerDetails["amountInFromAsset"],
                "htlcScriptAddress": spvHtlc.result["address"], "ownerPubkey": btcMakerPubkey, "timeout": SPV_TIME}]), 0, true);

            if (extHtlcTxid["error"] != null) {
                sendAlarm("btc maker icx_submitexthtlc failed");
                continue;
            }

            const spvFundTxid = (await waitSPVConnected(async () => {
                return await rpcMethod('spv_sendtoaddress', [spvHtlc.result["address"], offerDetails["amountInFromAsset"]])
            })).result;

            if (spvFundTxid["error"] != null) {
                sendAlarm("btc maker spv_sendtoaddress failed");
                continue;
            }

            console.log("Fund spv htlc with txid result: " + JSON.stringify(spvFundTxid));

            let offerData = {"seed": seed, "hash": hash, "exthtlc": extHtlcTxid, "timeout": timeout, "amount": offerDetails["amountInFromAsset"] };
            mapOfferData.set(key, offerData);
        }
    }
}

async function checkOfferDfcHtlc(offerData, offerId) {
    console.log("Checking dfc htlc of offer " + offerId);

    if (mapOfferDfcClaim.has(offerId)) {
        console.log("Offer id: " + offerId + " already claimed in dBTC tx " + mapOfferDfcClaim.get(offerId));
        return;
    }

    const listHtlcs = (await rpcMethod('icx_listhtlcs', [{"offerTx": offerId}])).result;
    console.log("icx_listhtlcs result: " + JSON.stringify(listHtlcs));
    for (var key in listHtlcs) {
        if (key == "WARNING")
            continue;

        const htlcDetails = listHtlcs[key];
        if (htlcDetails["type"] == "DFC" && htlcDetails["status"] == "OPEN" && offerId == htlcDetails["offerTx"]) {
            const offerData = mapOfferData.get(offerId);

            const dfcClaimRes = await rpcMethod('icx_claimdfchtlc', [{"dfchtlcTx": key, "seed": offerData["seed"]}]);
            if (dfcClaimRes["error"] != null) {
                continue;
            }

            const dfcClaimTxid = dfcClaimRes.result;
            console.log("Claimed dBTC in txid: " + JSON.stringify(dfcClaimTxid));
            mapOfferDfcClaim.set(offerId, dfcClaimTxid.txid);
        }
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
}

(async() => {
    try{
        if (ownerAddress == null) {
            console.error("Please define DFI_ADDRESS in environment variable");
            return;
        }

        if (!btcMakerAddress || btcMakerAddress.length <= 0) {
            console.error("Please define SPV_BTC_ADDRESS in environment variable");
            return;
        }
        
        loadExistingData();

        btcMakerPubkey = (await rpcMethod('spv_getaddresspubkey', [btcMakerAddress])).result;
        if (btcMakerPubkey.length <= 0) {
            console.error("Don't have ownership of btc address: " + btcMakerAddress);
            return;
        }
        console.log("Btc pubkey: " + btcMakerPubkey);

        while(true) {
            const orderTxId = await createOrderIfNotExist(btcMakerPubkey);

            await acceptOfferIfAny(orderTxId);
            
            await mapOfferData.forEach(checkOfferDfcHtlc);

            await sleep(20000);
        }
    }catch(e) {
        console.error(e);
    }
})();
