import { rpcMethod, waitConfirmation, waitSPVConnected, sleep } from './util.js';
import { difference } from "https://deno.land/std@0.103.0/datetime/mod.ts";
import { time } from "https://deno.land/x/time.ts@v2.0.1/mod.ts";

const orderTimeout = 5000;
const minOrderLife = 1500;
const ownerAddress = Deno.env.get("DFI_ADDRESS");
const btcMakerAddress = Deno.env.get("SPV_BTC_ADDRESS");
let btcMakerPubkey = "";
const alarmHook = Deno.env.get("ALARM_HOOK");

let mapOfferData = new Map();
let mapOfferDfcClaim = new Map();
let objHashSeed = new Object();
let objSpvHtlcExpire = new Object();

const checkOrderSizeInterval = 1; // every hour check order size
let checkOrderSizeTime = new Date("2021-01-01"); // Set to an old time so when restart the script will check first.

async function sendAlarm(msg) {
    console.log(msg);

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
    const btcBalance = parseFloat((await rpcMethod('spv_getbalance', [])).result);
    console.log("BTC balance " + btcBalance);

    for (var key in orders) {
        if (key == "WARNING")
            continue;
        if (orders.hasOwnProperty(key)) {
            console.log(key + " -> " + JSON.stringify(orders[key]));
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
                    const timeDiffInHours = difference(time().now(), checkOrderSizeTime, { units: ["hours"]})["hours"];
                    if (timeDiffInHours > checkOrderSizeInterval) {
                        if (Math.abs(orderDetails["amountToFill"] - btcBalance) > 0.00001) {
                            const listOrderOffers = (await rpcMethod('icx_listorders', [{ "orderTx": key }])).result;
                            
                            let hasOffer = false;
                            for (var offerKey in listOrderOffers) {
                                if (offerKey == "WARNING")
                                    continue;
                                hasOffer = true;
                            }
                            // If the order size not match with balance and it don't have offer now, then close the order and recreate a new order.
                            if (!hasOffer) {
                                console.log(`Order ${key} size ${orderDetails["amountToFill"]} not match with the btc balance, close it and recreate new one`);
                                const closeTxid = await waitConfirmation(await rpcMethod('icx_closeorder', [key]), 0, true);
                                sendAlarm(`[btc maker] Order ${key} is closed in tx ${closeTxid}`);
                                continue;
                            }
                        }
                    }
                    console.log("Found order " + key);
                    return key;
                }else {
                    console.log(`Order ${key} is too old, close it`);
                    const closeTxid = await waitConfirmation(await rpcMethod('icx_closeorder', [key]), 0, true);
                    sendAlarm(`[btc maker] Order ${key} is closed in tx ${closeTxid}`);
                }
            }
        }
    }

    if (!foundOrder) {
        if (btcBalance <= 0.0001) {
            console.error("BTC balance too low");
            return;
        }

        const orderSize = btcBalance;

        console.log("Creating order with size " + orderSize);
        const orderTxId = await waitConfirmation(await rpcMethod('icx_createorder',
            [{"ownerAddress": ownerAddress,
              "chainFrom": "BTC",
              "tokenTo": "BTC",
              "amountFrom": orderSize,
              "orderPrice": 1,
              "expiry": orderTimeout}]), 0, true);
        if (orderTxId["error"] != null) {
            sendAlarm("[btc maker] icx_createorder failed");
            Deno.exit();
        }
        checkOrderSizeTime = time().now();
        sendAlarm("[btc maker] created order " + orderTxId);
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
    if (orderId == null || orderId.length <= 0) {
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
        console.log(`Offer detail: ${JSON.stringify(offerDetails)}`);
        if (offerDetails["status"] == "OPEN") {
            sendAlarm(`[btc maker] received offer ${key} with amount ${offerDetails["amount"]}`);
            const res = (await rpcMethod('spv_syncstatus'));
            if (res["result"] == null || !res["result"]["connected"]) {
                console.warn("spv not connected");
                sendAlarm("[btc maker] spv not connected");
                continue;
            }

            if (res["result"]["current"] != res["result"]["estimated"]) {
                console.warn("spv not full synced");
                sendAlarm("[btc maker] spv not full synced");
                continue;
            }

            const btcBlock = res["result"]["current"];

            const btcTakerPubkey = offerDetails["receivePubkey"];
            const SPV_TIMEOUT = 80;  // Must greater than CICXSubmitEXTHTLC::EUNOSPAYA_MINIMUM_TIMEOUT = 72;
            // Create the on maker side. Note. the timeout input is a string but not a number
            // If input number, will have "JSON value is not a string as expected" error.
            const spvHtlc = await waitSPVConnected(async () => {
                return await rpcMethod('spv_createhtlc', [btcTakerPubkey, btcMakerPubkey, SPV_TIMEOUT.toString()]);
            });

            if (spvHtlc["error"] != null) {
                sendAlarm("[btc maker] spv_createhtlc failed");
                continue;
            }

            sendAlarm("[btc maker] spv_createhtlc result: " + JSON.stringify(spvHtlc.result));
            
            const seed = spvHtlc.result["seed"];
            const hash = spvHtlc.result["seedhash"];
            console.log(`Seed/Hash generated: ${seed}/${hash}`);

            objHashSeed[hash] = seed;
            Deno.writeTextFileSync("./hashseed.json", JSON.stringify(objHashSeed));

            // Fund the spv htlc
            const spvFundRpy = (await waitSPVConnected(async () => {
                return await rpcMethod('spv_sendtoaddress', [spvHtlc.result["address"], offerDetails["amountInFromAsset"]])
            }));
            // const spvFundTxid = (await rpcMethod('spv_sendtoaddress', [spvHtlc.result["address"], offerDetails["amountInFromAsset"]])).result;

            if (spvFundRpy["error"] != null) {
                sendAlarm("[btc maker] spv_sendtoaddress failed");
                continue;
            }

            const spvFundTxid = spvFundRpy.result;

            if (spvFundTxid["txid"] == null) {
                sendAlarm("[btc maker] spv_sendtoaddress returns null");
                continue;
            }

            objSpvHtlcExpire[spvHtlc.result["address"]] = btcBlock + SPV_TIMEOUT + 2;
            Deno.writeTextFileSync("./spvhtlcexpire.json", JSON.stringify(objSpvHtlcExpire));

            sendAlarm(`[btc maker] Fund spv htlc ${spvHtlc.result["address"]} with txid result: ${spvFundTxid["txid"]}`);

            const extHtlcTxid = await waitConfirmation(await rpcMethod('icx_submitexthtlc',
                [{"offerTx": key, "hash": hash, "amount": offerDetails["amountInFromAsset"],
                "htlcScriptAddress": spvHtlc.result["address"], "ownerPubkey": btcMakerPubkey, "timeout": SPV_TIMEOUT}]), 0, true);

            if (extHtlcTxid["error"] != null) {
                sendAlarm("[btc maker] icx_submitexthtlc failed");
                continue;
            }
            sendAlarm(`[btc maker] icx_submitexthtlc txid: ${extHtlcTxid}`);
            let offerData = {"seed": seed, "hash": hash, "exthtlc": extHtlcTxid, "timeout": SPV_TIMEOUT, "amount": offerDetails["amountInFromAsset"] };
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
            sendAlarm("[btc maker] Claimed dBTC in txid: " + JSON.stringify(dfcClaimTxid));
            mapOfferDfcClaim.set(offerId, dfcClaimTxid.txid);
            sendAlarm(`[btc maker] Finished the whole swap process for offer: ${offerId}`);
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

    try {
        const textspvHtlcExpire = Deno.readTextFileSync("./spvhtlcexpire.json");
        if (textspvHtlcExpire.length > 0) {
            objSpvHtlcExpire = JSON.parse(textspvHtlcExpire);
            console.log("objSpvHtlcExpire: " + JSON.stringify(objSpvHtlcExpire));
        }
    } catch (e) {
        console.log("Skipped to load spvhtlcexpire.json");
    }
}

async function claimExpiredSpvHtlc() {
    const res = (await rpcMethod('spv_syncstatus'));
    if (res["result"] == null || !res["result"]["connected"]) {
        console.warn("spv not connected");
        sendAlarm("[btc maker] spv not connected");
        return;
    }

    if (res["result"]["current"] != res["result"]["estimated"]) {
        console.warn("spv not full synced");
        sendAlarm("[btc maker] spv not full synced");
        return;
    }
    const btcBlock = res["result"]["current"];

    let spvHtlcToRemove = Array();
    for (const spvHtlc in objSpvHtlcExpire) {
        const expireBlock = objSpvHtlcExpire[spvHtlc];

        if (btcBlock > expireBlock) {
            spvHtlcToRemove.push(spvHtlc);
            const res = (await rpcMethod('spv_refundhtlc', [spvHtlc, btcMakerAddress]));
            if (res["error"] != null) {
                console.log(`SPV HTLC ${spvHtlc} already claimed`);
            }else if (res["result"] != null && res["result"]["txid"]) {
                console.log(`Successfully claimed back btc in SPV HTLC ${spvHtlc} in txid ${res["result"]["txid"]}`);
            }
        }
    }

    if (spvHtlcToRemove.length > 0) {
        // Remove the already checked one
        spvHtlcToRemove.forEach((spvHtlc) => {
            delete objSpvHtlcExpire[spvHtlc];

            Deno.writeTextFileSync("./claimedspvhtlc.json", spvHtlc + "\n", { append: true});

            console.log(`Delete spv htlc expire ${spvHtlc}`);
        });

        if (Object.keys(objSpvHtlcExpire).length > 0) {
            Deno.writeTextFileSync("./spvhtlcexpire.json", JSON.stringify(objSpvHtlcExpire));
        }else {
            console.log(`Remove file spvhtlcexpire.json`);
            Deno.removeSync("./spvhtlcexpire.json");
        }
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

            claimExpiredSpvHtlc();

            await sleep(20000);
        }
    }catch(e) {
        console.error(e);
    }
})();
