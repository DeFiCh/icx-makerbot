import { rpcMethod, waitConfirmation, waitSPVConnected, sleep } from './util1.js';

const ownerAddress  = Deno.args[4];

(async() => {
   try{

      let times = 0;
      const RUN_TIMES = 20;
      while(times <= RUN_TIMES) {
         times++;
         if (times % 2 == 0) {
            console.log("Start to swap DFI to BTC");
            const swapTxId = await waitConfirmation(await rpcMethod('poolswap',
                  [{"from": ownerAddress, "tokenFrom": "DFI", "amountFrom": 10, "to": ownerAddress, "tokenTo": "BTC", "maxPrice":20000}]));
            console.log("Swap DFI to BTC in " + swapTxId + " done");
         }else {
            console.log("Start to swap BTC to DFI");
            const swapTxId = await waitConfirmation(await rpcMethod('poolswap',
                  [{"from": ownerAddress, "tokenFrom": "BTC", "amountFrom": 0.0006, "to": ownerAddress, "tokenTo": "DFI", "maxPrice":1}]));
            console.log("Swap BTC to DFI in " + swapTxId + " done");
         }
      }
   }catch(e) {
      console.error(e);
  }
})();
