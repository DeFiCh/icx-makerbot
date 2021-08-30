import { rpcMethod, waitConfirmation, waitSPVConnected, createSeedHashPair, sleep, BOT_VERSION } from './util.js';
import { difference } from "https://deno.land/std@0.103.0/datetime/mod.ts";
import { time } from "https://deno.land/x/time.ts@v2.0.1/mod.ts";

const orderTimeout = 5000;
const minOrderLife = 1500;
const ownerAddress = Deno.env.get("DFI_ADDRESS");
const btcReceiveAddress = Deno.env.get("SPV_BTC_ADDRESS");
let btcReceiverPubkey = "";
const alarmHook = Deno.env.get("ALARM_HOOK");

let objOfferData = new Object();
let objOfferSpvHtlc = new Object();
let mapOfferSpvClaim = new Map();
let objHashSeed = new Object();

const checkOrderSizeInterval = 1; // every hour check order size
let checkOrderSizeTime = new Date("2021-01-01"); // Set to an old time so when restart the script will check first.

let objStatistics = new Object();

const outputStatisticsInterval = 6; // very 6 hours output statistics
let outputStatisticsTime = new Date("2021-01-01"); // Set to an old time so when restart the script will output first.

let objOrderHtlcExpire = new Object(); // To help check if can close the order.
let dfcHeaderBlock = 0;

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

async function canDeleteOrder(orderId) {
    if (objOrderHtlcExpire[orderId] != null && Object.keys(objOrderHtlcExpire[orderId]).length > 0) {
        return false;
    }

    const listOrderOffers = (await rpcMethod('icx_listorders', [{"orderTx": orderId}], true)).result;

    for (var offerKey in listOrderOffers) {
        if (offerKey == "WARNING")
            continue;
        return false; // Has offer, cannot delete order
    }

    return true;
}

async function createOrderIfNotExist() {
    const res = (await rpcMethod('getblockchaininfo', [], true));
    if (res["result"] == null || res["result"]["headers"] == null) {
        sendAlarm("[dbtc maker] Failed to getblockchaininfo");
        return;
    }

    dfcHeaderBlock = res["result"]["headers"];

    const orders = (await rpcMethod('icx_listorders', [], true)).result;
    var foundOrder = false;
    var foundedOrder = "";
    const accountBalance = (await rpcMethod('getaccount', [ownerAddress])).result;
    var btcBalance = 0;
    console.log("Account balance " + accountBalance);
    accountBalance.forEach((item) => {
        if (item.includes("@BTC")) {
            btcBalance = parseFloat(item);
            return;
        }
    });
    console.log("BTC balance " + btcBalance);

    for (var key in orders) {
        if (key == "WARNING")
            continue;
        if (orders.hasOwnProperty(key)) {
            console.log(key + " -> " + JSON.stringify(orders[key]));
            const orderDetails = orders[key];
            if (orderDetails["type"] == "INTERNAL" &&
                orderDetails["ownerAddress"] == ownerAddress &&
                orderDetails["tokenFrom"] == "BTC" &&
                orderDetails["chainTo"] == "BTC")
            {
                console.log(`Order ${key} expiration height ${orderDetails["expireHeight"]}, blockchain header block ${dfcHeaderBlock}`);
                if (foundOrder) {
                    sendAlarm(`[dbtc maker] Already have order ${foundedOrder}, close extra order ${key}`);
                    const closeTxid = await waitConfirmation(await rpcMethod('icx_closeorder', [key]), 0, true);
                    sendAlarm(`[dbtc maker] Order ${key} is closed in tx ${JSON.stringify(closeTxid)}`);
                } else {
                    if (orderDetails["expireHeight"] > dfcHeaderBlock + minOrderLife) {
                        const timeDiffInHours = difference(time().now(), checkOrderSizeTime, { units: ["hours"] })["hours"];
                        if (timeDiffInHours > checkOrderSizeInterval) {
                            if (Math.abs(orderDetails["amountToFill"] - btcBalance) > 0.00001) {
                                const canDel = await canDeleteOrder(key);
                                // If the order size not match with balance and it don't have offer now, then close the order and recreate a new order.
                                if (canDel) {
                                    sendAlarm(`[dbtc maker] Order ${key} size ${orderDetails["amountToFill"]} not match with the btc balance, close it and recreate new one`);
                                    const closeTxid = await waitConfirmation(await rpcMethod('icx_closeorder', [key]), 0, true);
                                    sendAlarm(`[dbtc maker] Order ${key} is closed in tx ${JSON.stringify(closeTxid)}`);
                                    continue;
                                }
                            }
                        }
                        console.log("Found order " + key);
                        objStatistics["dbtcInOrder"] = orderDetails["amountFrom"];
                        foundOrder = true;
                        foundedOrder = key;
                    } else {
                        sendAlarm(`[dbtc maker] Order ${key} is too old, close it`);
                        const closeTxid = (await waitConfirmation(await rpcMethod('icx_closeorder', [key]), 0, true));
                        sendAlarm(`[dbtc maker] Order ${key} is closed in tx ${JSON.stringify(closeTxid)}`);
                    }
                }
            }
        }
    }

    if (foundOrder) {
        return foundedOrder;
    } else {
        if (btcBalance <= 0.0001) {
            console.error("dBTC balance too low");
            return;
        }

        const orderSize = btcBalance;

        console.log("Creating order with size " + orderSize);
        const orderTxId = await waitConfirmation(await rpcMethod('icx_createorder',
            [{"ownerAddress": ownerAddress,
              "tokenFrom": "BTC",
              "chainTo": "BTC",
              "amountFrom": orderSize,
              "orderPrice": 1,
              "receivePubkey": btcReceiverPubkey,
              "expiry": orderTimeout}]),
              0, true);
        if (orderTxId["error"] != null) {
            sendAlarm("[dbtc maker] icx_createorder failed");
            return;
        }

        checkOrderSizeTime = time().now();
        objStatistics["dbtcInOrder"] = orderSize;
        Deno.writeTextFileSync("./dbtcmakerstatistics.json", JSON.stringify(objStatistics));

        objOrderHtlcExpire[orderTxId] = new Object();
        Deno.writeTextFileSync("./orderhtlcexpire.json", JSON.stringify(objOrderHtlcExpire));

        sendAlarm(`[dbtc maker] created order ${orderTxId}, dbtc in order: ${orderSize}`);
        return orderTxId;
    }
}

async function checkExistingDfcHtlc(offerId) {
    console.log("checkExistingDfcHtlc for offerId: " + offerId);
    if (objOfferData.hasOwnProperty(offerId)) {
        console.log("Offer " + offerId + " already has dfc htlc " + objOfferData[offerId]["dfchtlc"])
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

            let offerData = {
                "seed": seed,
                "hash": hash,
                "dfchtlc": key,
                "timeout": htlcDetails["timeout"],
                "amount": htlcDetails["amount"],
                "expire": dfcHeaderBlock + htlcDetails["timeout"]
            };
            objOfferData[offerId] = offerData;
            Deno.writeTextFileSync("./DBtcOfferData.json", JSON.stringify(objOfferData));
        }
    }
}

async function acceptOfferIfAny(orderId) {
    if (orderId == null || orderId.length <= 0) {
        console.error("empty order id input");
        return;
    }

    const listOrderOffers = (await rpcMethod('icx_listorders', [{"orderTx": orderId}], true)).result;

    for (var key in listOrderOffers) {
        if (key == "WARNING")
            continue;

        await checkExistingDfcHtlc(key);
    }

    for (var key in listOrderOffers) {
        if (key == "WARNING")
            continue;

        if (objOfferData.hasOwnProperty(key)) {
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

            const TIMEOUT = 1500; // Must grater than 1439, because CICXSubmitDFCHTLC::MINIMUM_TIMEOUT limit.
            const dfcHtlcTxid = await waitConfirmation(await rpcMethod('icx_submitdfchtlc',
                [{"offerTx": key, "hash": hash, "amount": offerDetails["amount"], "timeout": TIMEOUT }]), 0, true);

            if (dfcHtlcTxid["error"] != null) {
                sendAlarm("[dbtc maker] icx_submitdfchtlc failed");
                continue;
            }

            objStatistics["dbtcInHtlc"] += offerDetails["amount"];
            Deno.writeTextFileSync("./dbtcmakerstatistics.json", JSON.stringify(objStatistics));

            let offerData = {
                "seed": seed, "hash": hash,
                "dfchtlc": dfcHtlcTxid,
                "timeout": TIMEOUT,
                "amount": offerDetails["amount"],
                "orderid": orderId,
                "expire": dfcHeaderBlock + TIMEOUT
            };
            objOfferData[key] = offerData;
            Deno.writeTextFileSync("./DBtcOfferData.json", JSON.stringify(objOfferData));

            objOrderHtlcExpire[orderId][dfcHtlcTxid] = dfcHeaderBlock + TIMEOUT;
            Deno.writeTextFileSync("./orderhtlcexpire.json", JSON.stringify(objOrderHtlcExpire));

            sendAlarm(`[dbtc maker] accepted offer ${key} by call icx_submitdfchtlc with txid: ${dfcHtlcTxid}, amount: ${offerDetails["amount"]}`);
        }
    }
}

async function checkOfferSpvHtlc(offerId) {
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

            if (spvHtlc["error"] != null) {
                sendAlarm("[dbtc maker] spv_createhtlc failed");
                continue;
            }

            objOfferSpvHtlc[offerId] = spvHtlc.result["address"];

            Deno.writeTextFileSync("./offerspvhtlc.json", JSON.stringify(objOfferSpvHtlc));

            sendAlarm("[dbtc maker] spv_createhtlc address result: " + objOfferSpvHtlc[offerId]);
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
        if (!objOfferData.hasOwnProperty(offerId)) {
            const msg = `[dbtc maker] offer ${offerId} don't have htlc data`;
            sendAlarm(msg);
            console.error(msg);
            return;
        }

        const offerData = objOfferData[offerId];
        if (listSpvReceived[0]["amount"] != offerData["amount"]) {
            sendAlarm(`[dbtc maker] The spv received amount ${listSpvReceived[0]["amount"]} not match with offer amount ${offerData["amount"]}!`);
        }

        const claimInput = [spvHtlc, btcReceiveAddress, offerData["seed"]];
        console.log("spv_claimhtlc input: " + JSON.stringify(claimInput));
        const claimBtcTxid = await waitSPVConnected(async () => {
            return await rpcMethod('spv_claimhtlc', claimInput, false, false);
        });

        if (claimBtcTxid["error"] != null) {
            sendAlarm("[dbtc maker] spv_claimhtlc failed");
            return;
        }

        sendAlarm(`[dbtc maker] SPV claim txid: ${claimBtcTxid.result["txid"]}`);

        mapOfferSpvClaim.set(offerId, claimBtcTxid.result["txid"]);

        delete objOfferData[offerId];
        Deno.writeTextFileSync("./DBtcOfferData.json", JSON.stringify(objOfferData));

        sendAlarm(`[dbtc maker] Finished the whole swap process for offer: ${offerId}`);

        const orderId = offerData["orderid"];
        const dfchtlc = offerData["dfchtlc"];
        delete objOrderHtlcExpire[orderId][dfchtlc];
        Deno.writeTextFileSync("./orderhtlcexpire.json", JSON.stringify(objOrderHtlcExpire));

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

    try {
        const textStatistics = Deno.readTextFileSync("./dbtcmakerstatistics.json");
        if (textStatistics.length > 0) {
            objStatistics = JSON.parse(textStatistics);
            console.log("objStatistics: " + JSON.stringify(objStatistics));
        }
    } catch (e) {
        console.log("Skipped to load dbtcmakerstatistics.json");
    }

    try {
        const textOrderHtlcExpire = Deno.readTextFileSync("./orderhtlcexpire.json");
        if (textOrderHtlcExpire.length > 0) {
            objOrderHtlcExpire = JSON.parse(textOrderHtlcExpire);
            console.log("objOrderHtlcExpire: " + JSON.stringify(objOrderHtlcExpire));
        }
    } catch (e) {
        console.log("Skipped to load orderhtlcexpire.json");
    }

    try {
        const textDBtcOfferData = Deno.readTextFileSync("./DBtcOfferData.json");
        if (textBtcOfferData.length > 0) {
            objOfferData = JSON.parse(textDBtcOfferData);
            console.log("objOfferData: " + JSON.stringify(objOfferData));
        }
    }catch(e) {
        console.log("Skipped to load DBtcOfferData.json");
    }
}

async function outputStatistics() {
    const timeDiffInHours = difference(time().now(), outputStatisticsTime, { units: ["hours"] })["hours"];
    if (timeDiffInHours < outputStatisticsInterval) {
        return;
    }

    outputStatisticsTime = time().now();

    const accountBalance = (await rpcMethod('getaccount', [ownerAddress])).result;
    var dbtcBalance = 0, dfiTokenBalance = 0;
    console.log("Account balance " + accountBalance);
    accountBalance.forEach((item) => {
        if (item.includes("@BTC")) {
            dbtcBalance = parseFloat(item);
        }else if (item.includes("@DFI")) {
            dfiTokenBalance = parseFloat(item);
        }
    });

    const dfiUtxoBalance = (await rpcMethod('getbalance')).result;
    const btcBalance = parseFloat((await rpcMethod('spv_getbalance', [])).result);
    var dbtcInHtlc = 0;
    if (objStatistics["dbtcInHtlc"] != null) {
        dbtcInHtlc = objStatistics["dbtcInHtlc"];
    }

    sendAlarm(`[dbtc maker] Order size: ${objStatistics["dbtcInOrder"]}, BTC balance: ${btcBalance}, dBTC balance: ${dbtcBalance}, DFI Token balance: ${dfiTokenBalance}, DFI UTXO balance: ${dfiUtxoBalance}, Total dbtc amount in HTLC: ${dbtcInHtlc}`);
}

async function removeExpiredHtlc() {
    var deletedItem = false;
    for (var orderId in objOrderHtlcExpire) {
        if (objOrderHtlcExpire.hasOwnProperty(orderId)) {
            for (var dfchtlc in objOrderHtlcExpire[orderId]) {
                if (objOrderHtlcExpire[orderId].hasOwnProperty(dfchtlc)) {
                    if (objOrderHtlcExpire[orderId][dfchtlc] < dfcHeaderBlock) {
                        sendAlarm(`[dbtc maker] deleted expired dfthtlc ${dfchtlc} of order ${orderId} at block ${dfcHeaderBlock}`);
                        delete objOrderHtlcExpire[orderId][dfchtlc];
                        deletedItem = true;
                    }
                }
            }
        }
    }

    if (deletedItem) {
        Deno.writeTextFileSync("./orderhtlcexpire.json", JSON.stringify(objOrderHtlcExpire));
    }

    for (var offerId in objOfferData) {
        if (objOfferData.hasOwnProperty(offerId)) {
            if (objOfferData[offerId]["expire"] < dfcHeaderBlock) {
                delete objOfferData[offerId];
                Deno.writeTextFileSync("./DBtcOfferData.json", JSON.stringify(objOfferData));
            }
        }
    }
}

(async() => {
    try{
        if (ownerAddress == null) {
            console.error("Please define DFI_ADDRESS in environment variable");
            return;
        }

        if (!btcReceiveAddress || btcReceiveAddress.length <= 0) {
            console.error("Please define SPV_BTC_ADDRESS in environment variable");
            return;
        }

        sendAlarm(`[dbtc maker] started bot with version ${BOT_VERSION}`);
        
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

            for (var offerId in objOfferData) {
                if (objOfferData.hasOwnProperty(offerId)) {
                    checkOfferSpvHtlc(offerId);
                }
            }

            for (var offerId in objOfferSpvHtlc) {
                await checkHtlcOutputAndClaim(offerId);
            }

            await removeExpiredHtlc();

            await outputStatistics();

            await sleep(20000);
        }
    }catch(e) {
        console.error(e);
    }
})();
