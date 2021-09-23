import btcMakerBot from "./icx_bot_btc_maker.js";
import dbtcMakerBot from "./icx_bot_dbtc_maker.js";

// TYPE = DBTC | BTC
const makerType = Deno.env.get("TYPE");

switch (makerType) {
  case "DBTC":
    dbtcMakerBot();
    break;
  case "BTC":
    btcMakerBot();
    break;
  default:
    console.error("Please define TYPE in environment variable");
    break;
}
