import { Base64 } from "https://deno.land/x/bb64/mod.ts";
import Kia from "https://deno.land/x/kia@0.3.0/mod.ts";
import { createHash } from "https://deno.land/std@0.74.0/hash/mod.ts";
import { cryptoRandomString } from "https://deno.land/x/crypto_random_string@1.0.0/mod.ts"
import { decodeString } from "https://deno.land/std/encoding/hex.ts"

export const ownerAddress = Deno.args[4];

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const rpcMethod = async (method, params, hideSpinner, ignoreError) => {
    const kia = hideSpinner || new Kia(`Performing: ${method}`);
    if(!hideSpinner) {
        kia.start();
    }

    let rpcData = {'jsonrpc': '1.0', 'id': 'rpctest', 'method': method, 'params': params || [] };


    let res = await fetch(`http://${Deno.args[0]}:${Deno.args[1]}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + 
                Base64.fromString(`${Deno.args[2]}:${Deno.args[3]}`).toString()},
            body: JSON.stringify(rpcData)
        }
    );

    const resJson = (await res.json());
    if(resJson.error && !ignoreError) {
        console.error('<<< Error >>>');
        console.error(resJson.error);
        if(resJson.error && resJson.error.message) {
            console.error(resJson.error.message);
        }
        Deno.exit();
    }


    if(!hideSpinner) {
        kia.succeed(`Completed: ${method}`);
    }

    return resJson;
}

export const waitConfirmation = async (txResult, waitUntil, hideSpinner) => {
    const result = txResult.result ? txResult.result : txResult;
    const txHash = result.txid ? result.txid : result;

    const kia = hideSpinner || new Kia(`Confirming tx id: ${txHash}`);
    if(!hideSpinner) {
        kia.start();
    }

    let unconfirmed = true;
    while(unconfirmed) {
        const txInfo = await rpcMethod('gettransaction', [txHash], true);
        const confirmations = txInfo.result.confirmations;
        if(!hideSpinner) {
            await kia.set({ text: `Confirming tx id: ${txHash} Confirmations: ${confirmations}` });
        }
        unconfirmed = confirmations <= (waitUntil ? waitUntil : 0);
        unconfirmed && await sleep(1000);
    }

    if(!hideSpinner) {
        kia.succeed(`Tx id: ${txHash} confirmed`);
    }

    return txHash;
}

export const waitSPVConnected = async (callback, hideSpinner) => {
    const kia = hideSpinner || new Kia(`Ensuring SPV sync`);
    if(!hideSpinner) {
        kia.start();
    }

    let response;
    while(!response) {
        if(!hideSpinner) {
            const syncStatus = (await rpcMethod('spv_syncstatus'));
            await kia.set({ text: `Waiting for SPV, sync status: ${JSON.stringify(syncStatus)}` });
        }
        response = await callback();

        if(response.error && response.error.code === -1) {
            response = null;
        }

        !response && await sleep(1000);
    }

    if(!hideSpinner) {
        kia.succeed(`SPV tx submitted`);
    }

    return response;
}

export const waitEvent = async (callback, hideSpinner) => {
    const kia = hideSpinner || new Kia(`Waiting for event`);
    if(!hideSpinner) {
        kia.start();
    }

    let unconfirmed = true;
    while(unconfirmed) {
        if(!hideSpinner) {
            await kia.set({ text: `Waiting for event` });
        }
        unconfirmed = callback();
        unconfirmed && await sleep(1000);
    }

    if(!hideSpinner) {
        kia.succeed(`Event found`);
    }

    return;
}

export const fundUTXOS = async (address) => {
    const kia = new Kia(`Funding UTXOs`);
    address = address || ownerAddress;
    kia.start();

    const sendToAddress = await rpcMethod('sendtoaddress', [address, 1], true);
    await waitConfirmation(sendToAddress, 1, true);

    kia.succeed(`UTXOs funded`);
}

export const createSeedHashPair = (useSeed) => {
    const seed = useSeed || cryptoRandomString({length: 64});
    let hash = createHash('sha256');
    hash.update(decodeString(seed));
    
    return { seed: seed, hash: hash.toString('hex')};
}
